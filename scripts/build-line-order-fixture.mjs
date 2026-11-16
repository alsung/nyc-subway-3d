// Regenerates tests/fixtures/line-order-feed.json from an unzipped GTFS feed.
//
// The line-order tests need real stop patterns, because the cases worth pinning
// (the A's four ends, the 5 splitting at E 180 St, the G running straight
// through) are facts about the actual system and can't be written by hand. But
// CI never downloads the feed, and stop_times.txt isn't kept even locally:
// download-gtfs.sh deletes it once line-order.json is written. So this reads an
// unzipped copy of the ZIP download-gtfs.sh fetches (its GTFS_URL) and commits
// only what the tests use: each fixture line's distinct patterns, its daytime
// stations and their names.
//
// Run: node scripts/build-line-order-fixture.mjs <unzipped feed dir>
// (reads public/stations.json too, so run `npm run gtfs` first)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCSV } from '../src/core/gtfs-parser.js';
import { linePatterns, daytimeStations } from '../src/core/line-order.js';

// One straight line, one with three branches off one trunk, and one where two
// branches join before running on as one.
const LINES = ['G', 'A', '5'];

const feedDir = process.argv[2];
if (!feedDir) {
    console.error('usage: node scripts/build-line-order-fixture.mjs <unzipped feed dir>');
    process.exit(2);
}

const csv = (file) => parseCSV(readFileSync(join(feedDir, file), 'utf8'));
const stops = csv('stops.txt');
const patterns = linePatterns(csv('stop_times.txt'), csv('trips.txt'), stops);
const shortName = new Map(csv('routes.txt').map(r => [r.route_id, r.route_short_name]));
const feed = csv('feed_info.txt')[0]?.feed_version ?? 'unknown';
const stations = JSON.parse(readFileSync(new URL('../public/stations.json', import.meta.url), 'utf8'));
const stopName = new Map(stops.map(s => [s.stop_id, s.stop_name]));

const lines = {};
const used = new Set();
for (const line of LINES) {
    const linePats = patterns.get(line) ?? [];
    const served = new Set(linePats.flat());
    const daytime = [...daytimeStations(stations, shortName.get(line) ?? line)].filter(id => served.has(id));
    lines[line] = { patterns: linePats, daytime: daytime.sort() };
    for (const id of served) used.add(id);
}

const names = Object.fromEntries([...used].sort().map(id => [id, stopName.get(id)]));
const path = new URL('../tests/fixtures/line-order-feed.json', import.meta.url);
writeFileSync(path, JSON.stringify({ feed, lines, names }) + '\n');

const count = Object.values(lines).reduce((n, l) => n + l.patterns.length, 0);
console.log(`Wrote ${count} patterns for ${LINES.join(', ')} from feed ${feed}`);
