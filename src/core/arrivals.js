// src/core/arrivals.js
// Merges the per-station arrivals responses that back a single popup.
//
// A station complex spans several GTFS station IDs, so opening one popup fans
// out to several /api/arrivals/:id requests. The old code collapsed every
// outcome into `array | null`: a failed request became an empty array, and an
// empty result and a total failure both rendered as a bare "—". That made
// "MTA is not publishing predictions here" indistinguishable from "our request
// failed", which is precisely the ambiguity that made the Phase 5 yellow-line
// investigation take as long as it did.
//
// This module keeps the outcome, so the UI can say which one happened.

// How old the server's data may be before arrivals are labelled delayed.
// Matches the vehicles staleness window in main.js; the API refreshes its feed
// cache every 30s, so 90s means roughly three missed refreshes.
export const ARRIVALS_STALE_MS = 90_000;

/**
 * Merges the results of Promise.allSettled over fetchArrivals() calls.
 *
 * Returns { status, arrivals, updatedAt, failedCount, requestCount } where
 * status is one of:
 *   'ok'      — every request succeeded and there is at least one arrival
 *   'partial' — at least one arrival, but some requests failed; the data shown
 *               is real but may be missing a platform of the complex
 *   'empty'   — every request succeeded and there are no arrivals at all
 *   'error'   — every request failed
 *
 * `arrivals` is deduped by tripId and sorted ascending by minutes. `updatedAt`
 * is the oldest timestamp among the successful responses — the pessimistic
 * choice, since the popup is only as fresh as its stalest constituent.
 */
export function mergeArrivalResults(settled) {
    const fulfilled = settled.filter(r => r.status === 'fulfilled' && r.value);
    const failedCount = settled.length - fulfilled.length;

    if (fulfilled.length === 0) {
        return {
            status: 'error',
            arrivals: [],
            updatedAt: null,
            failedCount,
            requestCount: settled.length,
        };
    }

    const seen = new Set();
    const arrivals = [];
    for (const { value } of fulfilled) {
        for (const a of value.arrivals ?? []) {
            // tripId identifies a train, so the same train reported by two
            // platforms of one complex collapses to a single row.
            if (a && !seen.has(a.tripId)) {
                seen.add(a.tripId);
                arrivals.push(a);
            }
        }
    }
    arrivals.sort((a, b) => a.minutes - b.minutes);

    const updatedAt = oldestTimestamp(fulfilled.map(r => r.value.updatedAt));

    let status;
    if (arrivals.length === 0) status = 'empty';
    else if (failedCount > 0)  status = 'partial';
    else                       status = 'ok';

    return { status, arrivals, updatedAt, failedCount, requestCount: settled.length };
}

// Oldest parseable timestamp, or null when none parse. Unparseable values are
// ignored rather than treated as "now" — claiming data is fresh when we cannot
// tell is the failure mode this module exists to avoid.
function oldestTimestamp(stamps) {
    let oldest = null;
    for (const s of stamps) {
        if (!s) continue;
        const t = Date.parse(s);
        if (Number.isNaN(t)) continue;
        if (oldest === null || t < oldest) oldest = t;
    }
    return oldest === null ? null : new Date(oldest).toISOString();
}

// True when the server's data is old enough to warn about. A missing or
// unparseable timestamp counts as stale: we cannot show it is current.
export function isArrivalsStale(updatedAt, now = Date.now()) {
    if (!updatedAt) return true;
    const t = Date.parse(updatedAt);
    if (Number.isNaN(t)) return true;
    return now - t > ARRIVALS_STALE_MS;
}

// "just now" / "2 min ago" — for the quiet inline freshness note.
export function formatAge(updatedAt, now = Date.now()) {
    if (!updatedAt) return 'unknown';
    const t = Date.parse(updatedAt);
    if (Number.isNaN(t)) return 'unknown';
    const seconds = Math.max(0, Math.round((now - t) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return `${hours} hr ago`;
}
