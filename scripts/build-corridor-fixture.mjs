// Regenerates tests/fixtures/line-routes.json from a downloaded GTFS feed.
//
// public/gtfs is a build input, not a repo artifact — it is large, it goes
// stale, and CI never downloads it for the unit-test job. The corridor tests
// still need real geometry, because the assertions worth making ("Queens Blvd
// resolves to E/F/M/R", "no two trunks ever cross") are about the actual system
// and cannot be written by hand.
//
// So the geometry is downsampled to a fixed spacing and committed. Corridors
// are kilometers long and CORRIDOR_RADIUS_M is 60, so thinning to one point
// every ~60 m preserves every corridor while cutting the file by 3x. This is
// also why MIN_RUN_M is measured in meters: the threshold means the same thing
// at fixture density as at feed density.
//
// Run: node scripts/build-corridor-fixture.mjs   (after `npm run gtfs`)

import { readFileSync, writeFileSync } from 'node:fs';
import { parseShapes, parseTripsToRouteShapes } from '../src/core/gtfs-parser.js';
import { geoToLocalMeters } from '../src/core/geo.js';

const SPACING_M = 60;
const PRECISION = 5;            // ~1 m at this latitude

const read = (f) => readFileSync(new URL(`../public/gtfs/${f}`, import.meta.url), 'utf8');
const lineRoutes = parseTripsToRouteShapes(read('trips.txt'), parseShapes(read('shapes.txt')));

const round = (n) => Number(n.toFixed(PRECISION));

/** Keeps the first and last point, and one every SPACING_M in between. */
function thin(coords) {
    const out = [coords[0]];
    let last = geoToLocalMeters(coords[0][0], coords[0][1]);
    for (let i = 1; i < coords.length - 1; i++) {
        const p = geoToLocalMeters(coords[i][0], coords[i][1]);
        if (Math.hypot(p.x - last.x, p.y - last.y) < SPACING_M) continue;
        out.push(coords[i]);
        last = p;
    }
    out.push(coords[coords.length - 1]);
    return out.map(([lat, lng]) => [round(lat), round(lng)]);
}

const fixture = {};
for (const [routeId, polylines] of Object.entries(lineRoutes)) {
    const kept = polylines.filter(c => c.length > 1).map(thin);
    if (kept.length) fixture[routeId] = kept;
}

const count = (obj) => Object.values(obj).flat().reduce((a, c) => a + c.length, 0);
const before = count(lineRoutes);
const after = count(fixture);

const path = new URL('../tests/fixtures/line-routes.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(fixture)}\n`);
const polylines = Object.values(fixture).reduce((a, c) => a + c.length, 0);
console.log(`${Object.keys(fixture).length} routes, ${polylines} polylines, ${before} -> ${after} points`);
