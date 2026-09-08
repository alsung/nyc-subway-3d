// Post-build assertion: the GTFS static files must be in dist/.
//
// Every Vercel deployment up to 2026-08-11 shipped without them. The app did
// not crash — it silently fell back to an embedded 45-station dataset (out of
// 496) and rendered a map that looked plausible but was ~9% of the network.
// The SPA rewrite made the missing files return index.html with HTTP 200, so
// nothing in the pipeline registered a failure.
//
// This turns that silent degradation into a failed build.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const REQUIRED = ['stops.txt', 'routes.txt', 'shapes.txt', 'trips.txt'];
const MIN_BYTES = 1024;

// Station metadata carries the borough and direction labels behind the popup's
// direction tabs. Missing, the tabs would silently fall back to generic
// compass labels — degraded rather than broken, which is exactly the shape of
// failure this file exists to catch.
const MIN_STATIONS = 490;

const problems = [];

for (const name of REQUIRED) {
    const path = join(DIST, 'gtfs', name);
    let size;
    try {
        size = statSync(path).size;
    } catch {
        problems.push(`${path} is missing — did prebuild (scripts/download-gtfs.sh) run?`);
        continue;
    }
    if (size < MIN_BYTES) {
        problems.push(`${path} is only ${size} bytes — looks truncated`);
        continue;
    }
    // Guard against an HTML error page having been saved as a .txt.
    const head = readFileSync(path, 'utf8').slice(0, 200).trimStart();
    if (head.startsWith('<')) {
        problems.push(`${path} starts with '<' — that is markup, not CSV`);
        continue;
    }
    if (!head.includes(',')) {
        problems.push(`${path} has no comma in its first line — not valid GTFS CSV`);
    }
}

// stations.json — a JSON array, not CSV, so it gets its own checks.
try {
    const raw = readFileSync(join(DIST, 'stations.json'), 'utf8');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) {
        problems.push('dist/stations.json is not a JSON array');
    } else if (rows.length < MIN_STATIONS) {
        problems.push(`dist/stations.json has ${rows.length} stations, expected at least ${MIN_STATIONS}`);
    } else if (!rows[0]?.gtfs_stop_id || !rows[0]?.borough) {
        problems.push('dist/stations.json rows are missing gtfs_stop_id or borough');
    }
} catch (err) {
    problems.push(`dist/stations.json unreadable — did prebuild run? (${err.message})`);
}

if (problems.length) {
    console.error('\nBuild verification failed:\n');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('\nRefusing to ship a build that would silently fall back to embedded data.\n');
    process.exit(1);
}

console.log(`✓ build verified — ${REQUIRED.length} GTFS files in ${DIST}/gtfs, station metadata present`);
