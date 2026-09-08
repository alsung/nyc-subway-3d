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
 * Falls back to the first id present at all, so an unrecognised trunk still
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

/** Human-readable borough for a station, or '' when unknown. */
export function boroughName(meta, stopId) {
    return BOROUGH_NAME[meta?.get(stopId)?.borough] ?? '';
}
