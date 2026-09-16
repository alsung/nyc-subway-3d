// Fetches subway platform polygons from OpenStreetMap into public/platforms.json.
//
// MTA publishes no station interiors — its GTFS feed carries no pathways.txt or
// levels.txt — but OSM carries platform geometry for every station in the
// system. A spike measured the coverage before any of this was written:
//
//   platform polygons        496 / 496 stations (150 m radius)
//   carrying a `level` tag   476 / 496
//   asset                    ~222 kB raw, ~55 kB gzipped
//
// What OSM does not have, at least not usefully, is the rest of the interior.
// Filtering `indoor=*` to structural features only (corridor, room, area, level,
// wall), just 84 of 445 complexes carry any and exactly two carry real detail.
// `indoor=yes` turns out to mean furniture — the hundred "indoor ways" first
// counted at Huguenot were 98 benches. So this fetches platforms and nothing
// else, and the feature is platform layout rather than a cutaway.
//
// Run: node scripts/fetch-platforms.mjs
//
// OSM data is ODbL. The map already credits OpenStreetMap for basemap tiles;
// redistributing this asset is a derivative database and carries share-alike
// obligations that the MTA feed does not.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];

// NYC, tiled so no single query is large enough to time out.
const BBOX = { s: 40.49, w: -74.26, n: 40.92, e: -73.69 };
const ROWS = 4;
const COLS = 4;

// A platform this far from a station's coordinates belongs to it. Wide enough to
// reach the far end of a long platform from the station's center point, narrow
// enough not to capture a neighboring station's.
const JOIN_RADIUS_M = 150;

const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos(40.73 * Math.PI / 180);

const query = (bbox) => `[out:json][timeout:180];
way["railway"="platform"](${bbox});
out geom tags;`;

// Tiles are cached to disk. Overpass rate-limits hard — a first attempt at this
// died on HTTP 429 partway through — and re-downloading the tiles that already
// succeeded is both slow and rude. Delete the cache directory to force a
// refresh.
const CACHE = new URL('../.cache/platforms/', import.meta.url);

async function fetchTile(name, bbox, attempt = 0) {
    const cached = new URL(`${name}.json`, CACHE);
    if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));

    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
        const res = await fetch(endpoint, { method: 'POST', body: query(bbox) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        mkdirSync(CACHE, { recursive: true });
        writeFileSync(cached, JSON.stringify(data));
        return data;
    } catch (err) {
        if (attempt >= 5) throw err;
        // Overpass asks for a minute after a 429; shorter backoff just earns
        // another one.
        const wait = 30_000 * (attempt + 1);
        console.log(`    retry ${attempt + 1} after ${wait / 1000}s (${err.message})`);
        await new Promise(r => setTimeout(r, wait));
        return fetchTile(name, bbox, attempt + 1);
    }
}

const centroid = (geometry) => {
    let lat = 0;
    let lon = 0;
    for (const p of geometry) { lat += p.lat; lon += p.lon; }
    return { lat: lat / geometry.length, lng: lon / geometry.length };
};

const here = new URL('.', import.meta.url);
const stations = JSON.parse(readFileSync(new URL('../public/stations.json', here), 'utf8'));

// Station coordinates come from GTFS, which is the same source the app uses, so
// the join lands on the same points the map draws.
const stops = readFileSync(new URL('../public/gtfs/stops.txt', here), 'utf8')
    .split('\n').slice(1)
    .map(line => line.split(','))
    .filter(f => f[4] === '1' && f[2])
    .map(f => ({ id: f[0], lat: Number(f[2]), lng: Number(f[3]) }));

const complexOf = new Map(stations.map(s => [s.gtfs_stop_id, s.complex_id]));

console.log(`${stops.length} stations, fetching platforms in ${ROWS * COLS} tiles`);

const seen = new Set();
const ways = [];
const dLat = (BBOX.n - BBOX.s) / ROWS;
const dLng = (BBOX.e - BBOX.w) / COLS;

for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
        const s = BBOX.s + r * dLat;
        const w = BBOX.w + c * dLng;
        const bbox = `${s.toFixed(4)},${w.toFixed(4)},${(s + dLat).toFixed(4)},${(w + dLng).toFixed(4)}`;
        process.stdout.write(`  tile ${r}${c} ... `);
        const data = await fetchTile(`${r}${c}`, bbox);
        let added = 0;
        for (const el of data.elements ?? []) {
            if (!el.geometry?.length || seen.has(el.id)) continue;
            seen.add(el.id);
            ways.push(el);
            added++;
        }
        console.log(`${added} platforms`);
        await new Promise(r2 => setTimeout(r2, 2000));
    }
}

// Join each platform to the nearest station within the radius, then key by the
// complex — the same grouping the popup, the entrances and search already use.
const out = [];
let unjoined = 0;
const r2 = JOIN_RADIUS_M * JOIN_RADIUS_M;

for (const way of ways) {
    const c = centroid(way.geometry);
    let best = null;
    let bestD2 = r2;
    for (const stop of stops) {
        const dy = (stop.lat - c.lat) * M_PER_DEG_LAT;
        const dx = (stop.lng - c.lng) * M_PER_DEG_LNG;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = stop; }
    }
    if (!best) { unjoined++; continue; }

    const level = way.tags?.level;
    out.push({
        // complex id, falling back to the station id for anything MTA's dataset
        // does not list
        c: complexOf.get(best.id) ?? best.id,
        // level as written by OSM: a storey index, not a depth. Kept verbatim so
        // the renderer owns the convention rather than this script.
        l: level === undefined ? null : Number(level),
        g: way.geometry.map(p => [Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6))]),
    });
}

const path = new URL('../public/platforms.json', here);
const json = JSON.stringify(out);
writeFileSync(path, json);

const complexes = new Set(out.map(p => p.c));
const levelled = out.filter(p => p.l !== null).length;
console.log(`\n${out.length} platforms across ${complexes.size} complexes`);
console.log(`${levelled} carry a level (${(100 * levelled / out.length).toFixed(0)}%)`);
console.log(`${unjoined} platforms matched no station within ${JOIN_RADIUS_M} m and were dropped`);
console.log(`${(json.length / 1024).toFixed(0)} kB raw -> public/platforms.json`);
