// src/core/trunks.js
// Groups GTFS route ids into the eleven trunk lines riders actually name.
//
// This exists client-side rather than being read off /api/alerts/summary so the
// Lines control keeps working when the alerts API is down — filtering the map is
// unrelated to service status, and should not fail with it. The order matches
// TRUNK_ORDER in alert-status.js so the two panels list the system the same way.
//
// Express variants fold into their parent trunk: FX is the Brooklyn F express,
// 6X the Pelham Bay express, 7X the Flushing express. They are the same physical
// line, and a rider choosing to hide "the F" means the express too.

export const TRUNKS = [
    { key: 'ACE',  routeIds: ['A', 'C', 'E'] },
    { key: 'BDFM', routeIds: ['B', 'D', 'F', 'FX', 'M'] },
    { key: 'G',    routeIds: ['G'] },
    { key: 'JZ',   routeIds: ['J', 'Z'] },
    { key: 'L',    routeIds: ['L'] },
    { key: 'NQRW', routeIds: ['N', 'Q', 'R', 'W'] },
    { key: '123',  routeIds: ['1', '2', '3'] },
    { key: '456',  routeIds: ['4', '5', '6', '6X'] },
    { key: '7',    routeIds: ['7', '7X'] },
    { key: 'S',    routeIds: ['GS', 'FS', 'H'] },
    { key: 'SIR',  routeIds: ['SI'] },
];

// Routes that are an express pattern of another line rather than a line of
// their own. GTFS gives them their own route_id and short name, but no rider
// calls one "the FX" — the MTA signs them as a diamond F, 6 or 7. They are
// filtered before the trunk's bullets are drawn, and still toggled with the
// parent trunk.
const EXPRESS_VARIANTS = new Set(['FX', '6X', '7X']);

/**
 * The routes in a trunk that should get a bullet.
 *
 * Falls back to the full list when filtering would leave a trunk with no
 * bullets at all, so a feed that ships only the express pattern still renders
 * something rather than an empty row.
 */
export function bulletRoutes(routeIds) {
    const signed = (routeIds ?? []).filter(id => !EXPRESS_VARIANTS.has(id));
    return signed.length ? signed : (routeIds ?? []);
}

/**
 * The trunks present in a given routeMap, in TRUNKS order.
 *
 * Only routes the map actually loaded are listed, so a trunk missing from the
 * feed produces no empty row. Any route id the table does not know about is
 * collected into a trailing "Other" trunk rather than dropped — silently losing
 * a line from the filter would leave it permanently visible with no way to turn
 * it off, which is worse than an unfamiliar heading.
 */
export function trunksFor(routeMap) {
    const available = new Set(Object.keys(routeMap ?? {}));
    const claimed = new Set();
    const out = [];

    for (const trunk of TRUNKS) {
        const routeIds = trunk.routeIds.filter(id => available.has(id));
        for (const id of routeIds) claimed.add(id);
        if (routeIds.length) out.push({ key: trunk.key, routeIds });
    }

    const orphans = [...available].filter(id => !claimed.has(id));
    if (orphans.length) out.push({ key: 'Other', routeIds: orphans });

    return out;
}

// Built once from TRUNKS rather than maintained alongside it, so a route added
// to the table above cannot be forgotten here.
const TRUNK_BY_ROUTE = new Map(
    TRUNKS.flatMap(trunk => trunk.routeIds.map(id => [id, trunk.key])),
);

/**
 * The trunk key a route belongs to, or null if the table does not know it.
 *
 * Callers that group by trunk must handle null rather than assuming coverage:
 * trunksFor() deliberately keeps unknown routes visible under an "Other"
 * heading, and a route the feed adds tomorrow should not silently vanish from
 * whatever is grouping.
 *
 * @param {string} routeId
 * @returns {string|null}
 */
export function trunkOf(routeId) {
    return TRUNK_BY_ROUTE.get(routeId) ?? null;
}
