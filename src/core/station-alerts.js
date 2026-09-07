// src/core/station-alerts.js
// Maps service alerts onto individual stations, for the map badge and the
// station popup.
//
// The MTA scopes alerts two different ways, and both matter here:
//
//   station-scoped — "No Scheduled Service", "Stops Skipped", "Part Suspended".
//                    Carries stopIds. These are the alerts that explain why a
//                    station has no arrivals.
//   route-scoped   — "Delays", "Reduced Service". Carries routeIds and an EMPTY
//                    stopIds, because a delay affects a line rather than a
//                    platform.
//
// Verified against the live feed: both "Delays" alerts carried zero stopIds
// while "No Scheduled Service" reached 81 stations. Anything keyed on incidents
// having stopIds would therefore surface nothing at all.

/**
 * The set of station ids named directly by a surfaced alert — what the map
 * badges.
 *
 * Deliberately keyed on "the alert names this stop" rather than on the alert's
 * label. Labels come from MTA's Mercury extension, which fails silently when
 * their wording changes (the reason the alerts_labeled gauge exists); a badge
 * driven by a label allowlist would go quietly wrong. Whether MTA attached a
 * stop to an alert is a fact, not a string match.
 *
 * Route-scoped alerts contribute nothing here by construction, since they carry
 * no stopIds. That is correct for the map: a delay on the A is not a property
 * of any one station.
 */
export function alertedStationIds(alerts) {
    const out = new Set();
    for (const alert of alerts ?? []) {
        if (!alert?.surfaced) continue;
        for (const id of alert.stopIds ?? []) out.add(id);
    }
    return out;
}

/**
 * The alerts worth showing inside one station's popup.
 *
 * stationIds is the station's own id plus its complex siblings; routeIds are
 * the routes actually seen arriving there.
 *
 * Two rules, because the two scopes mean different things:
 *
 *   station-scoped — always shown. MTA attached this stop to the alert, so it
 *                    is about this station whether planned or not.
 *   route-scoped   — shown only for incidents. A delay on the A changes how the
 *                    arrival times on screen should be read. Planned work with
 *                    no stops attached is scheduling context, not a disruption
 *                    here — the live feed's "Sunday Schedule" notice covers 22
 *                    of 29 routes, so admitting it would put an identical row in
 *                    essentially every popup in the system. That belongs in the
 *                    Service Status panel, which exists to list it once.
 *
 * Station-scoped matches are ordered first: an alert that names this stop is
 * more specific than one that happens to touch a line passing through it.
 */
export function alertsForStation(alerts, stationIds, routeIds) {
    const stops = new Set(stationIds ?? []);
    const routes = new Set(routeIds ?? []);

    const direct = [];
    const viaRoute = [];

    for (const alert of alerts ?? []) {
        if (!alert?.surfaced) continue;

        if ((alert.stopIds ?? []).some(id => stops.has(id))) {
            direct.push(alert);
            continue;
        }
        // Only alerts with no stops of their own fall through to route
        // matching. One that named specific stops and missed ours is about
        // those stops, not this one.
        if ((alert.stopIds ?? []).length === 0
            && alert.kind === 'incident'
            && (alert.routeIds ?? []).some(id => routes.has(id))) {
            viaRoute.push(alert);
        }
    }

    return [...direct, ...viaRoute];
}
