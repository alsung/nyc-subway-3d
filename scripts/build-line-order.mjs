// Writes public/line-order.json: each line's daytime stations in order, with
// branches as separate sections (#153).
//
// scripts/download-gtfs.sh runs this once per download, while stop_times.txt
// still sits in its temporary folder. stop_times.txt is 36 MB and is the only
// file in the feed that knows stop order, so it is read here and then deleted
// with the rest of the temporary folder, and never reaches public/ or dist/.
// The algorithm lives in src/core/line-order.js.
//
// Run by hand:
//   node scripts/build-line-order.mjs <stop_times.txt> <gtfs dir> <stations.json> <out.json>
// where <gtfs dir> holds trips.txt, stops.txt and routes.txt from the same
// download as stop_times.txt.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCSV } from '../src/core/gtfs-parser.js';
import { buildLineOrder } from '../src/core/line-order.js';

// 26 lines today, counting the three shuttles and the Staten Island Railway.
// A couple can drop out during a long suspension without anything being wrong;
// many more than that means the files didn't line up.
const MIN_LINES = 24;

const [stopTimesPath, gtfsDir, stationsPath, outPath] = process.argv.slice(2);
if (!outPath) {
    console.error('usage: node scripts/build-line-order.mjs <stop_times.txt> <gtfs dir> <stations.json> <out.json>');
    process.exit(2);
}

const csv = (path) => parseCSV(readFileSync(path, 'utf8'));
const { lines, fallbacks, empty } = buildLineOrder({
    stopTimes: csv(stopTimesPath),
    trips: csv(join(gtfsDir, 'trips.txt')),
    stops: csv(join(gtfsDir, 'stops.txt')),
    routes: csv(join(gtfsDir, 'routes.txt')),
    stations: JSON.parse(readFileSync(stationsPath, 'utf8')),
});

for (const line of fallbacks) {
    console.warn(`WARNING: the ${line}'s stations loop back on themselves; using its longest pattern instead`);
}
for (const line of empty) {
    console.warn(`WARNING: the ${line} has no stations on MTA's daytime list; it gets no stop order`);
}

const count = Object.keys(lines).length;
if (count < MIN_LINES) {
    console.error(`ERROR: stop order came back for only ${count} lines, expected at least ${MIN_LINES}.`);
    console.error('Are stop_times.txt and trips.txt from the same download? Run: npm run gtfs');
    process.exit(1);
}

writeFileSync(outPath, JSON.stringify(lines));
const sections = Object.values(lines).reduce((n, s) => n + s.length, 0);
console.log(`Stop order for ${count} lines in ${sections} sections`);
