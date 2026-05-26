// src/core/gtfs-loader.js
// Fetches MTA GTFS static files from /gtfs/ and falls back to embedded data
// if any file is missing or the fetch fails.

import { parseGTFS } from './gtfs-parser.js';
import { EMBEDDED_STATIONS, EMBEDDED_ROUTES, EMBEDDED_SHAPES } from '../data/embedded.js';

const GTFS_FILES = ['stops.txt', 'routes.txt', 'shapes.txt', 'trips.txt'];
const GTFS_BASE  = '/gtfs';

export async function loadGTFS() {
    // fetch all four GTFS files in parallel via Promise.allSettled
    const results = await Promise.allSettled(
        GTFS_FILES.map(f => fetch(`${GTFS_BASE}/${f}`))
    );

    // if any fetch fails or returns a non-ok status, log a warning and return null
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected' || !r.value.ok) {
            console.warn(`[gtfs-loader] failed to load ${GTFS_FILES[i]} — using embedded data`);
            return null;
        }
    }

    // all four succeeded — resolve text content in parallel
    // null signals to the caller that it should fall back to embedded data
    const [stops, routes, shapes, trips] = await Promise.all(
        results.map(r => r.value.text())
    );
    return { stops, routes, shapes, trips };
}

export async function loadAndParseGTFS() {
    // call loadGTFS()
    const raw = await loadGTFS();

    // if result is null: call buildFromEmbedded() and return it
    if (raw === null) return buildFromEmbedded();

    // if result is non-null: call parseGTFS(stops, routes, shapes, trips) and return it
    // both branches return the same shape: { stations, childToParent, routeMap, lineRoutes }
    return parseGTFS(raw.stops, raw.routes, raw.shapes, raw.trips);
}

function buildFromEmbedded() {
    // routeMap: reduce EMBEDDED_ROUTES into { [id]: route } keyed by route id
    const routeMap = EMBEDDED_ROUTES.reduce((map, route) => {
        map[route.id] = route;
        return map;
    }, {});

    // lineRoutes: EMBEDDED_SHAPES is already { [routeId]: [[lat, lng], ...] } — use directly
    // childToParent is empty — embedded stations are parents only, no platform children
    // construct a { stations, childToParent, routeMap, lineRoutes } object
    return {
        stations: EMBEDDED_STATIONS,
        childToParent: {},
        routeMap,
        lineRoutes: EMBEDDED_SHAPES,
    };
}
