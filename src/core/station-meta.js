// src/core/station-meta.js
// Per-station borough and direction labels, from MTA's own Subway Stations
// dataset (public/stations.json, fetched at build time).
//
// This exists because GTFS carries neither. A direction label like "Uptown" or
// "Queens" is an editorial choice MTA makes per station, and it cannot be
// derived from geometry — 5 Av/53 St is in Manhattan but its northbound label
// is "Queens", because the E does not run uptown from there. Borough cannot be
// derived from coordinates either: Inwood-207 St sits north and east of Bronx
// stations, since the border is the Harlem River rather than a latitude.

import { TRUNKS } from './trunks.js';
const BOROUGH_NAME = {
    M:  'Manhattan',
    Bk: 'Brooklyn',
    Q:  'Queens',
    Bx: 'The Bronx',   // MTA's own labels say "The Bronx", not "Bronx"
    SI: 'Staten Island',
};

// Labels that describe a compass heading rather than a destination. 230 of the
// 992 label slots in the dataset use one of these — 23% — and they tell a rider
// nothing, which is why MTA's own app substitutes a borough for them. Every
// other value in the dataset names a place.
const GENERIC = new Set(['northbound', 'southbound', 'eastbound', 'westbound', 'outbound', 'inbound']);

// Not generic, despite reading like a state rather than a place: it means the
// train terminates here, so there is no service in that direction at all.
const LAST_STOP = 'Last Stop';

/**
 * Indexes the raw dataset rows by stop id.
 *
 * routes is a Set because a station complex carries one row per line group —
 * Jay St is A41 for "A C F" and R29 for "R" — and picking the right row for a
 * given trunk is a membership test.
 */
export function buildStationMeta(rows) {
    const meta = new Map();
    for (const r of rows ?? []) {
        const id = r?.gtfs_stop_id;
        if (!id) continue;
        meta.set(id, {
            complexId: r.complex_id ?? null,
            borough: r.borough ?? '',
            routes: new Set((r.daytime_routes ?? '').split(/\s+/).filter(Boolean)),
            north: r.north_direction_label ?? '',
            south: r.south_direction_label ?? '',
        });
    }
    return meta;
}

/**
 * The dataset row describing a particular trunk at a particular station.
 *
 * A complex spans several stop ids, each with its own labels, so "which way is
 * Manhattan" depends on which platform you mean. Times Sq carries five rows;
 * only one of them (902, "S") knows the shuttle runs to Grand Central rather
 * than uptown and downtown.
 *
 * routeLabels are display names, not GTFS route ids, because that is what the
 * dataset's daytime_routes column holds. The three shuttles are route ids GS,
 * FS and H but all display as "S", and the express variants FX, 6X and 7X
 * display as F, 6 and 7 — matching on ids finds none of them and silently
 * falls through to whichever platform happens to be listed first.
 *
 * Falls back to the first id present at all, so an unrecognized trunk still
 * gets labels rather than none.
 */
export function stopIdForTrunk(meta, stationIds, routeLabels) {
    const ids = stationIds ?? [];
    const wanted = new Set(routeLabels ?? []);

    for (const id of ids) {
        const row = meta?.get(id);
        if (!row) continue;
        for (const route of row.routes) {
            if (wanted.has(route)) return id;
        }
    }
    return ids.find(id => meta?.has(id)) ?? null;
}

/** Display names for a trunk's routes — what stopIdForTrunk matches against. */
export function routeLabelsFor(routeIds, routeMap) {
    return (routeIds ?? []).map(id => routeMap?.[id]?.shortName ?? id);
}

/**
 * What to call one direction at one station.
 *
 * Three sources, in order of how much they tell a rider:
 *
 *   1. MTA's own label, when it names a place ("Uptown", "Queens", "Coney
 *      Island"). This is the editorial answer and matches their app.
 *   2. The borough of where the train is actually going, when MTA's label is a
 *      bare compass heading. This is what their app appears to do too: Jay St's
 *      southbound label is "Southbound" in the data but reads "Brooklyn" in the
 *      app, and southbound R trains from there terminate in Brooklyn.
 *   3. The compass heading, when there is no destination to name either —
 *      truthful, just unhelpful.
 */
export function directionLabel(meta, stopId, direction, destinationStopId) {
    const row = meta?.get(stopId);
    const raw = direction === 'S' ? row?.south : row?.north;
    const fallback = direction === 'S' ? 'Southbound' : 'Northbound';

    if (raw && !GENERIC.has(raw.toLowerCase())) return raw;

    const destBorough = meta?.get(destinationStopId)?.borough;
    if (destBorough && BOROUGH_NAME[destBorough]) return BOROUGH_NAME[destBorough];

    return raw || fallback;
}

/** True when MTA marks this direction as terminating here. */
export function isLastStop(meta, stopId, direction) {
    const row = meta?.get(stopId);
    return (direction === 'S' ? row?.south : row?.north) === LAST_STOP;
}

/**
 * GTFS stop id → MTA complex id, for grouping platforms into stations.
 *
 * Separate from the metadata Map so gtfs-parser can take it without depending
 * on this module's shape — the grouping runs before anything else needs the
 * borough or the direction labels.
 */
export function complexIdIndex(meta) {
    const out = new Map();
    for (const [id, row] of meta ?? []) {
        if (row.complexId) out.set(id, row.complexId);
    }
    return out;
}

/**
 * How many routes serve each station, for station level-of-detail.
 *
 * This used to be derived from geometry: every route's curve was sampled at
 * 2,001 points and every station tested against all of them, 14,384 pairs, to
 * count how many lines passed near each dot. The dataset states it outright in
 * daytime_routes, so the geometry pass was measuring something it already knew —
 * and measuring it worse, since a curve passing near a station is not the same
 * claim as a route serving it.
 *
 * Counts display names, which is what the column holds: the three shuttles all
 * read "S" and the express variants read F, 6 and 7. That is the right unit for
 * level-of-detail, because it is the number of bullets a rider sees on the sign.
 *
 * Falls back to 1 for a station the dataset does not describe, which keeps it at
 * the smallest size rather than hiding it.
 */
export function routeCountByStation(meta) {
    const out = new Map();
    for (const [id, row] of meta ?? []) {
        out.set(id, row.routes?.size || 1);
    }
    return out;
}

/** Human-readable borough for a station, or '' when unknown. */
export function boroughName(meta, stopId) {
    return BOROUGH_NAME[meta?.get(stopId)?.borough] ?? '';
}

/**
 * The rows the search box lists: one per station complex, not one per GTFS
 * station.
 *
 * Search previously listed all 496 GTFS stations, which put four identical
 * "Times Sq-42 St" rows in the dropdown — one per platform group in the
 * complex. Collapsing to complexes cuts that to 445 rows and makes Times Sq a
 * single result.
 *
 * That alone is not enough. 55 names are still duplicated afterwards, and
 * borough resolves only 9 of them: four different 125 Sts are all in Manhattan,
 * distinguishable only as [1], [2 3], [4 5 6] and [A B C D]. So each row also
 * carries the routes it serves, which is what a rider actually recognises — the
 * same thing MTA's own app uses, where two "34 St-Penn Station" labels are told
 * apart by their bullets and no borough appears at all.
 *
 * Borough still earns its place: 36 St is Queens [M R] and Brooklyn [D N R],
 * and both carry the R, so the bullets alone are ambiguous there.
 *
 * Routes are ordered by trunk rather than alphabetically, so Times Sq reads
 * A C E · N Q R W · 1 2 3 · 7 · S the way the bullets are grouped on a station
 * sign.
 *
 * @param {{name: string, lat: number, lng: number, stationIds: string[]}[]} complexes
 * @param {Map<string, object>} meta from buildStationMeta
 * @returns {{id: string, name: string, lat: number, lng: number,
 *            stationIds: string[], routes: string[], borough: string}[]}
 */
export function buildSearchEntries(complexes, meta) {
    return (complexes ?? []).map(complex => {
        const ids = complex.stationIds ?? [];

        const routes = new Set();
        let borough = '';
        for (const id of ids) {
            const row = meta?.get(id);
            if (!row) continue;
            for (const route of row.routes ?? []) routes.add(route);
            if (!borough) borough = BOROUGH_NAME[row.borough] ?? '';
        }

        return {
            // The first member station. Everything downstream that expects a
            // station id — the entrance lookup, the popup — resolves from it,
            // and stationIds carries the rest.
            id: ids[0] ?? '',
            name: complex.name,
            lat: complex.lat,
            lng: complex.lng,
            stationIds: ids,
            routes: orderByTrunk([...routes]),
            borough,
        };
    });
}

/**
 * Route display names in trunk order.
 *
 * daytime_routes holds display names ("1", "FX" never appears), so this matches
 * on those rather than on GTFS route ids. Anything the trunk table does not
 * know sorts to the end rather than being dropped — an unfamiliar line should
 * still show a bullet.
 */
function orderByTrunk(routes) {
    const rank = new Map();
    let i = 0;
    for (const trunk of TRUNKS) {
        for (const id of trunk.routeIds) {
            if (!rank.has(id)) rank.set(id, i++);
        }
    }
    return routes.sort((a, b) => {
        const ra = rank.has(a) ? rank.get(a) : Number.MAX_SAFE_INTEGER;
        const rb = rank.has(b) ? rank.get(b) : Number.MAX_SAFE_INTEGER;
        return ra === rb ? a.localeCompare(b) : ra - rb;
    });
}

/**
 * The accessible name for one search result.
 *
 * An option's accessible name is its text content, and once route bullets are
 * inside the row that reads as "Times Sq-42 St123 7ACE...Manhattan". Screen
 * readers get this instead.
 */
export function searchEntryLabel(entry) {
    if (!entry?.name) return '';
    const parts = [entry.name];
    if (entry.routes?.length) parts.push(`lines ${entry.routes.join(' ')}`);
    if (entry.borough) parts.push(entry.borough);
    return parts.join(', ');
}
