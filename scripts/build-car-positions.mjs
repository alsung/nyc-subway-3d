// Precomputes platform axes and entrance positions for car positioning.
//
// For each platform polygon, PCA finds the long axis. Each entrance in the
// same complex is projected onto that axis, producing a normalized position
// (0..1) along the platform. At runtime the trip planner combines this with
// the train's approach direction to recommend front/middle/back.
//
// Run: node scripts/build-car-positions.mjs
//
// Input:  public/platforms.json, public/entrances.json
// Output: public/car-positions.json

import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(`public/${name}`, ROOT), 'utf8'));

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos(40.73 * Math.PI / 180);
const xy = (lat, lng) => [lng * M_PER_DEG_LNG, lat * M_PER_DEG_LAT];

// PCA on a polygon's vertices. A subway platform is a long thin rectangle,
// so the first principal component is its length direction.
function principalAxis(ring) {
    const pts = ring.map(([lat, lng]) => xy(lat, lng));
    const n = pts.length;
    const cx = pts.reduce((s, p) => s + p[0], 0) / n;
    const cy = pts.reduce((s, p) => s + p[1], 0) / n;

    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) {
        const dx = x - cx, dy = y - cy;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    sxx /= n; syy /= n; sxy /= n;

    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;

    let ax, ay;
    if (Math.abs(sxy) > 1e-9) { ax = l1 - syy; ay = sxy; }
    else if (sxx >= syy) { ax = 1; ay = 0; }
    else { ax = 0; ay = 1; }
    const len = Math.hypot(ax, ay) || 1;
    ax /= len; ay /= len;

    // Canonicalize: point northward (ay >= 0), breaking ties eastward.
    // Removes PCA's sign ambiguity so the axis is deterministic.
    if (ay < 0 || (ay === 0 && ax < 0)) { ax = -ax; ay = -ay; }

    let minA = Infinity, maxA = -Infinity;
    for (const [x, y] of pts) {
        const a = (x - cx) * ax + (y - cy) * ay;
        if (a < minA) minA = a;
        if (a > maxA) maxA = a;
    }

    return { cx, cy, ax, ay, minA, maxA, length: maxA - minA };
}

function project(axis, lat, lng) {
    const [x, y] = xy(lat, lng);
    const dx = x - axis.cx, dy = y - axis.cy;
    const a = dx * axis.ax + dy * axis.ay;
    const b = -dx * axis.ay + dy * axis.ax;
    return {
        u: (a - axis.minA) / (axis.maxA - axis.minA || 1),
        offAxis: Math.abs(b),
        beyondEnd: a < axis.minA ? axis.minA - a : a > axis.maxA ? a - axis.maxA : 0,
    };
}

const OFF_AXIS_LIMIT = 40;    // meters
const MIN_LENGTH     = 100;   // meters — shorter than any real platform
const MAX_LENGTH     = 250;   // meters — longer than any 10-car platform

const TYPE_ALIASES = {
    'Stair': 'stair', 'Stair/Escalator': 'stair', 'Stair/Ramp': 'stair',
    'Stair/Ramp/Walkway': 'stair', 'Elevator': 'elevator',
    'Escalator': 'escalator', 'Ramp': 'ramp', 'Station House': 'house',
    'Easement - Street': 'street', 'Easement - Passage': 'passage',
    'Underpass': 'passage', 'Walkway': 'passage', 'Overpass': 'passage',
};
const normalizeType = (t) => TYPE_ALIASES[t] ?? 'stair';

// ── load ────────────────────────────────────────────────────────────────────
const platforms  = read('platforms.json');
const entrances  = read('entrances.json');

// Group by complex.
const platsByComplex = new Map();
for (const p of platforms) {
    const cid = String(p.c);
    if (!platsByComplex.has(cid)) platsByComplex.set(cid, []);
    platsByComplex.get(cid).push(p);
}

const entsByComplex = new Map();
for (const e of entrances) {
    const cid = String(e.c);
    if (!entsByComplex.has(cid)) entsByComplex.set(cid, []);
    entsByComplex.get(cid).push(e);
}

// ── compute ─────────────────────────────────────────────────────────────────
const output = [];
let totalPlatforms = 0, totalPlaceable = 0, skippedLength = 0;

for (const [cid, plats] of platsByComplex) {
    const ents = entsByComplex.get(cid) ?? [];
    const complexPlatforms = [];

    for (const p of plats) {
        const axis = principalAxis(p.g);
        if (!Number.isFinite(axis.length) || axis.length < MIN_LENGTH || axis.length > MAX_LENGTH) {
            skippedLength++;
            continue;
        }
        totalPlatforms++;

        const placed = [];
        for (const e of ents) {
            const pr = project(axis, e.y, e.x);
            if (pr.offAxis <= OFF_AXIS_LIMIT && pr.beyondEnd === 0) {
                placed.push({
                    u: Math.round(pr.u * 1000) / 1000,
                    t: normalizeType(e.t),
                });
                totalPlaceable++;
            }
        }

        // Center in lat/lng, for proximity matching at runtime.
        const cLat = axis.cy / M_PER_DEG_LAT;
        const cLng = axis.cx / M_PER_DEG_LNG;

        complexPlatforms.push({
            ax: [round4(axis.ax), round4(axis.ay)],
            cx: [round6(cLng), round6(cLat)],
            len: Math.round(axis.length),
            e: placed,
        });
    }

    if (complexPlatforms.length) {
        output.push({ c: cid, p: complexPlatforms });
    }
}

function round4(n) { return Math.round(n * 10000) / 10000; }
function round6(n) { return Math.round(n * 1000000) / 1000000; }

// ── write ───────────────────────────────────────────────────────────────────
const json = JSON.stringify(output);
const outPath = new URL('../public/car-positions.json', import.meta.url);
writeFileSync(outPath, json + '\n');

console.log(`platforms with usable axis: ${totalPlatforms} (${skippedLength} skipped on length)`);
console.log(`placeable (platform, entrance) pairs: ${totalPlaceable}`);
console.log(`complexes in output: ${output.length}`);
console.log(`${(json.length / 1024).toFixed(0)} kB -> public/car-positions.json`);
