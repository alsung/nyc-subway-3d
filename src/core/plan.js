// src/core/plan.js
// Turns the API's itineraries into the shape the trip planner renders.
//
// Everything here is pure. The panel itself is DOM wiring, and this project has
// no DOM test environment — so the parts that can be wrong on their own live
// here, where they can be tested. That split is deliberate: what has actually
// broken in this app's UI before was state and formatting, not appendChild.

// Journeys the API considers plausible can still be useless to a rider. An
// itinerary arriving after this long is not one anybody would choose over
// waiting for the next train.
export const MAX_REASONABLE_MINUTES = 180;

/**
 * Seconds-from-midnight clock string ("13:39:30") to minutes past midnight.
 *
 * Returns null rather than NaN for anything unparseable, so callers branch on
 * absence instead of propagating a NaN through arithmetic and rendering "NaN
 * min" — the failure mode that produced an 809-minute journey on the server.
 */
export function clockToMinutes(clock) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(clock ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (min > 59) return null;
    return h * 60 + min;
}

/**
 * A clock string as a rider reads it: "1:39 PM".
 *
 * GTFS service-day clocks run past 24:00 — a train at 25:30 is 1:30 the next
 * morning — so the hour wraps rather than rendering "25:30 PM".
 */
export function formatClock(clock) {
    const mins = clockToMinutes(clock);
    if (mins === null) return '';
    const h24 = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    const suffix = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** "6 min", "1 hr 35 min". */
export function formatDuration(minutes) {
    const n = Math.round(Number(minutes));
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 60) return `${n} min`;
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** "Direct", "1 transfer", "2 transfers". */
export function formatTransfers(count) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return 'Direct';
    return n === 1 ? '1 transfer' : `${n} transfers`;
}

/**
 * The route ids a journey rides, in order, skipping walks.
 *
 * Used for the bullet row, which is how a rider recognises an itinerary at a
 * glance — "the L then the 2" is more legible than any duration.
 */
export function ridesOf(journey) {
    return (journey?.legs ?? [])
        .filter(l => l?.kind === 'ride' && l.routeId)
        .map(l => l.routeId);
}

/**
 * Whether any leg of a journey was planned on live predictions.
 *
 * The API marks each leg individually. Collapsing that to one flag per journey
 * is what the summary row needs; the leg list still shows it per leg.
 */
export function usesRealtime(journey) {
    return (journey?.legs ?? []).some(l => l?.timing === 'realtime');
}

/**
 * Normalises the API response into what the panel renders.
 *
 * Drops journeys that cannot be displayed honestly — no legs, or a duration
 * that says nothing useful — rather than rendering a blank or absurd row.
 * Ordering is preserved: the API returns fewest-transfers first and fastest
 * last, and re-sorting here would throw away the Pareto ordering RAPTOR
 * computed.
 */
export function normalizePlan(response) {
    const journeys = Array.isArray(response?.journeys) ? response.journeys : [];

    const usable = journeys
        .filter(j => Array.isArray(j?.legs) && j.legs.length > 0)
        .filter(j => {
            const mins = Number(j.minutes);
            return Number.isFinite(mins) && mins > 0 && mins <= MAX_REASONABLE_MINUTES;
        })
        .map(j => ({
            minutes: Number(j.minutes),
            transfers: Number(j.transfers) || 0,
            departAt: j.departAt ?? '',
            arriveAt: j.arriveAt ?? '',
            rides: ridesOf(j),
            realtime: usesRealtime(j),
            legs: j.legs,
        }));

    return {
        journeys: usable,
        // Negative means the API planned on the schedule alone. The distinction
        // is worth surfacing: a rider should know when nothing live informed
        // the answer.
        feedAgeSeconds: Number.isFinite(Number(response?.feedAgeSeconds))
            ? Number(response.feedAgeSeconds)
            : -1,
    };
}

/**
 * One line describing a leg, as the rider reads it.
 */
export function describeLeg(leg, nameOf = (id) => id) {
    if (!leg) return '';
    if (leg.kind === 'walk') {
        const mins = legMinutes(leg);
        const to = nameOf(leg.toStop);
        return mins > 0 ? `Walk ${mins} min to ${to}` : `Walk to ${to}`;
    }
    const stops = Array.isArray(leg.stops) ? leg.stops.length - 1 : 0;
    const to = nameOf(leg.toStop);
    return stops > 0 ? `${stops} stop${stops === 1 ? '' : 's'} to ${to}` : `To ${to}`;
}

/** Whole minutes a leg takes, or 0 when its times are missing. */
export function legMinutes(leg) {
    const from = clockToMinutes(leg?.departAt);
    const to = clockToMinutes(leg?.arriveAt);
    if (from === null || to === null) return 0;
    // A leg crossing midnight arrives at a smaller clock value.
    const delta = to - from;
    return delta >= 0 ? delta : delta + 24 * 60;
}
