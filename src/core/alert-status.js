// src/core/alert-status.js
// Presentation logic for the service status list, kept out of the DOM layer so
// the rules can be asserted directly.
//
// The right-hand cell of each trunk row adapts to how many alerts are active,
// mirroring MTA's own status page: with a single alert it names the alert type
// ("Delays"), with several it counts them, and with none it says so plainly.
// Showing "1 alert" when we know the alert is a delay wastes the most valuable
// line in the row.

// Fixed display order, matching the trunk ordering the API returns.
export const TRUNK_ORDER = ['ACE', 'BDFM', 'G', 'JZ', 'L', 'NQRW', '123', '456', '7', 'S', 'SIR'];

/**
 * Maps one trunk summary row to what the UI should render.
 *
 * Returns { text, tone, interactive } where tone is 'none' | 'planned' |
 * 'incident' and interactive reports whether the row should expand — a trunk
 * with nothing to show must not look tappable.
 */
export function trunkDisplay(trunk) {
    const count = Math.max(0, trunk?.count ?? 0);
    const status = trunk?.status ?? 'none';

    if (count === 0) {
        return { text: 'No alerts', tone: 'none', interactive: false };
    }
    if (count === 1) {
        // Fall back to a count when the label is missing — that happens when
        // MTA's extension could not be read, and "1 alert" is still true.
        const label = (trunk.label ?? '').trim();
        return { text: label || '1 alert', tone: status, interactive: true };
    }
    return { text: `${count} alerts`, tone: status, interactive: true };
}

/**
 * Overall system state, for the ambient dot on the Status button. An incident
 * anywhere outranks planned work anywhere, since only one of the two means
 * something is wrong right now.
 */
export function systemTone(trunks) {
    let tone = 'none';
    for (const t of trunks ?? []) {
        if ((t?.count ?? 0) === 0) continue;
        if (t.status === 'incident') return 'incident';
        if (t.status === 'planned') tone = 'planned';
    }
    return tone;
}

/**
 * Drops routes whose bullet would render identically to one already shown.
 *
 * The three shuttles (GS, FS, H) all carry route_short_name "S" in GTFS, so a
 * naive render puts three indistinguishable S bullets on the shuttle row. MTA
 * disambiguates them with superscripts; until we do the same, showing one S is
 * honest — a rider reads "S" either way — where three implies a distinction the
 * bullets do not actually make.
 */
export function dedupeBulletRoutes(routeIds, routeMap) {
    const seen = new Set();
    const out = [];
    for (const id of routeIds ?? []) {
        const label = routeMap?.[id]?.shortName ?? id;
        if (seen.has(label)) continue;
        seen.add(label);
        out.push(id);
    }
    return out;
}

/**
 * The alerts that belong to a trunk, for its expanded row. The summary endpoint
 * gives counts but not which alerts; this re-derives membership from routeIds
 * so the panel needs only the two responses it already fetches.
 *
 * Only surfaced alerts are considered — upcoming planned work is a separate
 * destination, and folding it in here would contradict the counts shown.
 */
export function alertsForTrunk(alerts, routeIds) {
    const inTrunk = new Set(routeIds ?? []);
    return (alerts ?? []).filter(
        a => a?.surfaced && (a.routeIds ?? []).some(r => inTrunk.has(r))
    );
}
