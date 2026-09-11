// src/core/corridors.js
// Finds where routes share a right-of-way, so they can be drawn as parallel
// strands instead of stacked on one polyline.
//
// The unit is the trunk, not the route. NYC colors by trunk, so the 4, 5 and 6
// are one green line to a rider; drawing them as three indistinguishable green
// strands adds width without adding information. The MTA's own app draws one
// strand per color and puts the service bullets on the station marker instead.
// Every route in a trunk therefore shares a rank and draws over its siblings,
// exactly as it does today.
//
// Why this is computed from geometry rather than declared in a table: a route's
// neighbors change along its length. The M runs with J/Z on Broadway-Brooklyn,
// with B/D/F on 6 Av and with E/F/R on Queens Blvd, and it needs a different
// rank in each. A per-route constant cannot express that.
//
// And endpoint heuristics are worse than useless here. The obvious way to make
// offset signs agree is to orient every polyline the same way, north to south
// or west to east — but the M's two termini are 4.0 km apart across a 29.6 km
// path (both in Queens, the route is a giant U), so it has no meaningful
// overall direction at all. Direction is resolved per segment instead, against
// whichever trunk in the corridor sorts first. Every member of a corridor
// measures itself against the same reference, so they agree by construction.

import { geoToLocalMeters, localMetersToGeo } from './geo.js';
import { TRUNKS, trunkOf } from './trunks.js';

// Two points this far apart in meters are treated as the same right-of-way.
// Wide enough to span a four-track trunk and the sampling jitter between two
// shapes drawn along it; narrow enough that parallel streets stay separate.
export const CORRIDOR_RADIUS_M = 60;

// A membership that persists for less than this many meters along the route is
// a crossing, not a corridor. Splitting there would emit a short segment at a
// different rank, which reads as a kink rather than a junction.
//
// Measured in meters rather than shape points because point spacing is not
// uniform: the feed samples some shapes every 5 m and others every 30 m, so a
// point count would filter a crossing on one line and keep the identical
// crossing on another. Two lines crossing at CORRIDOR_RADIUS_M produce roughly
// 2 x 60 m of shared run, so this sits comfortably above that and well below
// the length of any real shared corridor.
export const MIN_RUN_M = 250;

// The order strands sit in, across the whole system. Any total order gives the
// property that matters — if trunk X sorts before Y then X is on the same side
// of Y everywhere the two run together, so strands can never cross. TRUNKS
// already declares one, and reusing it keeps the map, the Lines panel and the
// alerts panel listing the system the same way.
const TRUNK_ORDER = TRUNKS.map(t => t.key);

// Routes the table does not know still have to be drawn. They share one bucket
// at the end rather than being dropped.
const OTHER = 'Other';
const ORDER = [...TRUNK_ORDER, OTHER];
const ORDER_INDEX = new Map(ORDER.map((key, i) => [key, i]));

// Membership is a bitmask over ORDER rather than a Set, so comparing two
// points' membership — done once per shape point — is an integer compare
// instead of a set walk.
const bit = (trunkKey) => 1 << ORDER_INDEX.get(trunkKey);

function decodeMask(mask) {
    const out = [];
    for (let i = 0; i < ORDER.length; i++) {
        if (mask & (1 << i)) out.push(ORDER[i]);
    }
    return out;
}

const trunkKeyOf = (routeId) => trunkOf(routeId) ?? OTHER;

/**
 * Projects every polyline once into local meters, flattened into shared typed
 * arrays with a parallel index of which polyline each point came from.
 *
 * The unit is the polyline, not the route: a route with branches is several
 * polylines, and the A's Rockaway branch is a different corridor from the A's
 * 8 Av trunk even though both are the A.
 *
 * One flat array rather than per-polyline arrays because the spatial hash below
 * stores indices into it: a cell holds numbers, not objects, so building the
 * hash allocates nothing per point.
 */
function projectAll(lineRoutes) {
    // lines[k] = { routeId, index } — index is the polyline's position within
    // its route, so a caller can line results up with its own input array.
    const lines = [];
    for (const routeId of Object.keys(lineRoutes)) {
        const polylines = lineRoutes[routeId];
        if (!Array.isArray(polylines)) continue;
        for (let i = 0; i < polylines.length; i++) {
            if ((polylines[i]?.length ?? 0) > 1) lines.push({ routeId, index: i });
        }
    }

    let total = 0;
    for (const { routeId, index } of lines) total += lineRoutes[routeId][index].length;

    const xs = new Float64Array(total);
    const ys = new Float64Array(total);
    // Distance along each polyline from its own first point, so a run's length
    // can be measured without walking its coordinates again.
    const along = new Float64Array(total);
    const trunkBit = new Int32Array(total);
    const lineAt = new Int32Array(total);
    const indexAt = new Int32Array(total);
    const offsets = new Map();

    let n = 0;
    for (let k = 0; k < lines.length; k++) {
        const { routeId, index } = lines[k];
        const coords = lineRoutes[routeId][index];
        const b = bit(trunkKeyOf(routeId));
        offsets.set(k, { start: n, length: coords.length });
        for (let i = 0; i < coords.length; i++) {
            const { x, y } = geoToLocalMeters(coords[i][0], coords[i][1]);
            xs[n] = x; ys[n] = y;
            along[n] = i === 0 ? 0 : along[n - 1] + Math.hypot(x - xs[n - 1], y - ys[n - 1]);
            trunkBit[n] = b;
            lineAt[n] = k;
            indexAt[n] = i;
            n++;
        }
    }
    return { lines, xs, ys, along, trunkBit, lineAt, indexAt, offsets, count: n };
}

// Cell coordinates are shifted into the positive range before packing so the
// key stays a small positive integer and Map lookups avoid string building.
const CELL_SHIFT = 1024;
const CELL_STRIDE = 4096;
const cellKey = (cy, cx) => (cy + CELL_SHIFT) * CELL_STRIDE + (cx + CELL_SHIFT);

function buildGrid(p, cellSize) {
    const grid = new Map();
    for (let i = 0; i < p.count; i++) {
        const key = cellKey(Math.floor(p.ys[i] / cellSize), Math.floor(p.xs[i] / cellSize));
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
    }
    return grid;
}

/** Every trunk with a point within `radius` of (x, y), as a bitmask. */
function maskNear(p, grid, cellSize, x, y, radius) {
    const r2 = radius * radius;
    const cy = Math.floor(y / cellSize);
    const cx = Math.floor(x / cellSize);
    let mask = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const bucket = grid.get(cellKey(cy + dy, cx + dx));
            if (!bucket) continue;
            for (const i of bucket) {
                if (mask & p.trunkBit[i]) continue;
                const ex = p.xs[i] - x;
                const ey = p.ys[i] - y;
                if (ex * ex + ey * ey <= r2) mask |= p.trunkBit[i];
            }
        }
    }
    return mask;
}

/** Run-length encodes a per-point mask array into { from, to, mask } runs. */
function runsOf(masks) {
    const runs = [];
    let start = 0;
    for (let i = 1; i <= masks.length; i++) {
        if (i === masks.length || masks[i] !== masks[start]) {
            runs.push({ from: start, to: i - 1, mask: masks[start] });
            start = i;
        }
    }
    return runs;
}

function coalesce(runs) {
    const out = [];
    for (const run of runs) {
        const last = out[out.length - 1];
        if (last && last.mask === run.mask) last.to = run.to;
        else out.push({ ...run });
    }
    return out;
}

/**
 * Absorbs runs shorter than minRun meters into their neighbor, repeatedly,
 * until every run is long enough or only one is left.
 *
 * Each pass strictly reduces the run count, so this terminates: a short run
 * adopts a neighbor's mask and the two coalesce into one.
 */
function mergeShortRuns(runs, minRunM, lengthOf) {
    let out = runs;
    while (out.length > 1) {
        let k = -1;
        for (let i = 0; i < out.length; i++) {
            if (lengthOf(out[i]) < minRunM) { k = i; break; }
        }
        if (k === -1) break;
        out[k].mask = k > 0 ? out[k - 1].mask : out[k + 1].mask;
        out = coalesce(out);
    }
    return out;
}

/**
 * Direction of travel at a point, measured over a window rather than between
 * neighboring vertices: consecutive shape points can be a couple of meters
 * apart, where rounding dominates the direction.
 */
function chordAt(p, start, length, i, window) {
    const a = Math.max(0, i - window);
    const b = Math.min(length - 1, i + window);
    return { dx: p.xs[start + b] - p.xs[start + a], dy: p.ys[start + b] - p.ys[start + a] };
}

/** Nearest point belonging to `trunkBitValue`, searched outward from (x, y). */
function nearestOfTrunk(p, grid, cellSize, x, y, trunkBitValue, maxRadius) {
    const span = Math.ceil(maxRadius / cellSize);
    const cy = Math.floor(y / cellSize);
    const cx = Math.floor(x / cellSize);
    let best = -1;
    let bestD2 = maxRadius * maxRadius;
    for (let dy = -span; dy <= span; dy++) {
        for (let dx = -span; dx <= span; dx++) {
            const bucket = grid.get(cellKey(cy + dy, cx + dx));
            if (!bucket) continue;
            for (const i of bucket) {
                if (p.trunkBit[i] !== trunkBitValue) continue;
                const ex = p.xs[i] - x;
                const ey = p.ys[i] - y;
                const d2 = ex * ex + ey * ey;
                if (d2 < bestD2) { bestD2 = d2; best = i; }
            }
        }
    }
    return best;
}

/**
 * Splits every polyline into segments over which its set of co-running trunks
 * is constant, and assigns each segment a rank and a direction.
 *
 * @param {Record<string, [number, number][][]>} lineRoutes routeId -> polylines
 * @param {{ radiusM?: number, minRunM?: number }} [options]
 * @returns {Map<string, {from: number, to: number, trunks: string[], rank: number,
 *                       canonical: string, flip: boolean}[][]>}
 *
 * One segment array per polyline, index-aligned with lineRoutes[routeId].
 *
 * `from` and `to` are inclusive indices into that route's own coordinate array.
 * `rank` is centered on zero, so a corridor's strands straddle the true
 * alignment and the station dots stay in the middle of the ribbon rather than
 * sitting off one edge of it.
 * `flip` is true when the segment runs against its canonical trunk, meaning a
 * consumer must reverse the coordinates (for Maplibre's direction-relative
 * line-offset) or negate the normal (for geometry it displaces itself).
 */
export function buildCorridors(lineRoutes, options = {}) {
    const radius = options.radiusM ?? CORRIDOR_RADIUS_M;
    const minRunM = options.minRunM ?? MIN_RUN_M;
    const cellSize = radius;

    const result = new Map();
    if (!lineRoutes) return result;

    const p = projectAll(lineRoutes);
    if (!p.count) return result;
    const grid = buildGrid(p, cellSize);

    for (let k = 0; k < p.lines.length; k++) {
        const { routeId, index } = p.lines[k];
        const { start, length } = p.offsets.get(k);
        const ownKey = trunkKeyOf(routeId);
        const ownBit = p.trunkBit[start];

        const masks = new Int32Array(length);
        for (let i = 0; i < length; i++) {
            masks[i] = maskNear(p, grid, cellSize, p.xs[start + i], p.ys[start + i], radius) | ownBit;
        }

        const lengthOf = (run) => p.along[start + run.to] - p.along[start + run.from];
        const runs = mergeShortRuns(runsOf(masks), minRunM, lengthOf);
        const segments = runs.map((run) => {
            const trunks = decodeMask(run.mask);
            const canonical = trunks[0];
            const rank = trunks.indexOf(ownKey) - (trunks.length - 1) / 2;
            return {
                from: run.from,
                to: run.to,
                trunks,
                rank,
                canonical,
                flip: flipAgainstCanonical(p, grid, cellSize, radius, start, length, run, canonical, ownBit),
            };
        });

        // Index-aligned with lineRoutes[routeId], so a caller can pair a
        // polyline with its segments by position.
        if (!result.has(routeId)) result.set(routeId, []);
        result.get(routeId)[index] = segments;
    }
    return result;
}

/**
 * Whether this segment runs opposite to its canonical trunk.
 *
 * The reference is the canonical trunk's nearest point to the segment's
 * midpoint. Because every route in a corridor resolves against the same trunk,
 * they all end up pointing the same way without any global orientation rule —
 * which is the only reason this works for routes like the M.
 */
function flipAgainstCanonical(p, grid, cellSize, radius, start, length, run, canonical, ownBit) {
    if (bit(canonical) === ownBit) return false;

    const mid = (run.from + run.to) >> 1;
    const x = p.xs[start + mid];
    const y = p.ys[start + mid];

    // Short runs that inherited their mask from a neighbor may have no
    // canonical point within the corridor radius, so the search widens once
    // before giving up.
    let j = nearestOfTrunk(p, grid, cellSize, x, y, bit(canonical), radius);
    if (j === -1) j = nearestOfTrunk(p, grid, cellSize, x, y, bit(canonical), radius * 2);
    if (j === -1) return false;

    const window = Math.max(1, Math.min(8, Math.floor((run.to - run.from + 1) / 2)));
    const own = chordAt(p, start, length, mid, window);

    const other = p.offsets.get(p.lineAt[j]);
    const ref = chordAt(p, other.start, other.length, p.indexAt[j], window);

    return own.dx * ref.dx + own.dy * ref.dy < 0;
}

/**
 * A segment's coordinates, oriented so that a positive rank is on the same side
 * for every route in the corridor.
 *
 * Segments overlap by one point so adjacent strands meet without a seam; the
 * caller emits one feature per segment and the shared vertex closes the gap.
 *
 * @param {[number, number][]} coords the route's full coordinate array
 * @param {{from: number, to: number, flip: boolean}} segment
 * @returns {[number, number][]}
 */
export function segmentCoords(coords, segment) {
    const from = Math.max(0, segment.from - 1);
    const slice = coords.slice(from, segment.to + 1);
    return segment.flip ? slice.reverse() : slice;
}

/**
 * Displaces a route's coordinates onto its own strand.
 *
 * Used by the 3D representation, which cannot lean on Maplibre's line-offset
 * and has to move the geometry itself. The displacement is perpendicular to the
 * local direction of travel and scaled by the segment's rank, so a route stays
 * parallel to its neighbors through curves rather than only on straights.
 *
 * @param {[number, number][]} coords
 * @param {{from: number, to: number, rank: number, flip: boolean}[]} segments
 * @param {number} metersPerRank
 * @returns {[number, number][]}
 */
export function offsetPoints(coords, segments, metersPerRank) {
    if (!segments?.length || !metersPerRank) return coords;

    const xs = new Float64Array(coords.length);
    const ys = new Float64Array(coords.length);
    for (let i = 0; i < coords.length; i++) {
        const { x, y } = geoToLocalMeters(coords[i][0], coords[i][1]);
        xs[i] = x; ys[i] = y;
    }

    const rankAt = new Float64Array(coords.length);
    const flipAt = new Int8Array(coords.length);
    for (const seg of segments) {
        for (let i = seg.from; i <= seg.to; i++) {
            rankAt[i] = seg.rank;
            flipAt[i] = seg.flip ? -1 : 1;
        }
    }

    const out = new Array(coords.length);
    for (let i = 0; i < coords.length; i++) {
        const rank = rankAt[i];
        if (!rank) { out[i] = coords[i]; continue; }

        const a = Math.max(0, i - 1);
        const b = Math.min(coords.length - 1, i + 1);
        const dx = xs[b] - xs[a];
        const dy = ys[b] - ys[a];
        const len = Math.hypot(dx, dy);
        if (!len) { out[i] = coords[i]; continue; }

        // y increases southward, so (-dy, dx) is a quarter turn clockwise on
        // screen — the same side Maplibre's positive line-offset uses.
        const shift = rank * metersPerRank * flipAt[i];
        const { lat, lng } = localMetersToGeo(
            xs[i] + (-dy / len) * shift,
            ys[i] + (dx / len) * shift,
        );
        out[i] = [lat, lng];
    }
    return out;
}
