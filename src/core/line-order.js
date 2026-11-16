// src/core/line-order.js
// Each line's stations in order, with branches as separate sections (#153).
//
// GTFS keeps stop order only in stop_times.txt, which is 36 MB and never ships.
// scripts/download-gtfs.sh reads it once per download, runs buildLineOrder, and
// writes the answer to public/line-order.json, about 5 KB, which the line card
// and the pre-built line pages read instead.
//
// Which stations count is MTA's call, not ours: the ones whose daytime_routes
// name the line, the same list the station popup draws its bullets from. The
// obvious rule, "use the most frequent stop pattern", was measured against the
// feed and dropped. The A's most frequent pattern is the Lefferts branch, at 39%
// of weekday trips, which would leave Far Rockaway and Rockaway Park off the A
// altogether. Late-night-only stops are left off as a result: the 2's overnight
// local serves 12 more stations than its daytime list.
//
// Everything reads from the north end, so the 1 starts at Van Cortlandt Park and
// the L at 8 Av. In MTA's feed direction 1 is southbound, so a direction 1 trip
// already reads that way and a direction 0 trip is reversed.
//
// The same pass records when each line runs (#154): on which kinds of day,
// whether it runs late at night and where, and otherwise its hours. That also
// lives only in stop_times.txt, and it's what lets a station say the C doesn't
// run late nights without anyone keeping a list by hand.

import { expressParent } from './trunks.js';

// The kinds of day hours are reported for, in the order they're shown.
export const DAY_TYPES = ['weekday', 'saturday', 'sunday'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

// Late night is 1 to 5 AM, in minutes after midnight. A line with trains at a
// station in that window runs there all night.
const NIGHT_START = 60;
const NIGHT_END = 300;

// When a line runs is tracked in quarter hours. A pause shorter than an hour is
// the wait between trains; anything longer is a break in service, like the Z's
// between the morning and evening rush.
const BUCKET = 15;
const MIN_BREAK = 60;

/**
 * Every distinct stop pattern each line runs, as parent station ids read from
 * the north end.
 *
 * Express routes fold into their line (6X into 6, 7X into 7, FX into F), the same
 * way the line URLs treat them, so the 6's stations include the Pelham express
 * pattern's. Trips missing from trips.txt are skipped.
 *
 * @param {Array<{trip_id: string, stop_id: string, stop_sequence: string}>} stopTimes
 * @param {Array<{trip_id: string, route_id: string, direction_id: string}>} trips
 * @param {Array<{stop_id: string, parent_station?: string}>} stops
 * @returns {Map<string, string[][]>} line route id → its patterns
 */
export function linePatterns(stopTimes, trips, stops) {
    const parentOf = new Map(stops.map(s => [s.stop_id, s.parent_station || s.stop_id]));
    const tripById = new Map(trips.map(t => [t.trip_id, t]));

    const byTrip = new Map();
    for (const st of stopTimes) {
        let list = byTrip.get(st.trip_id);
        if (!list) byTrip.set(st.trip_id, list = []);
        list.push([Number(st.stop_sequence), parentOf.get(st.stop_id) ?? st.stop_id]);
    }

    const patterns = new Map();
    for (const [tripId, list] of byTrip) {
        const trip = tripById.get(tripId);
        if (!trip) continue;
        list.sort((a, b) => a[0] - b[0]);
        const ids = list.map(([, id]) => id).filter((id, i, all) => id !== all[i - 1]);
        if (String(trip.direction_id) === '0') ids.reverse();

        const line = expressParent(trip.route_id) ?? trip.route_id;
        let seen = patterns.get(line);
        if (!seen) patterns.set(line, seen = new Map());
        seen.set(ids.join(' '), ids);
    }

    return new Map([...patterns].map(([line, seen]) => [line, [...seen.values()]]));
}

/**
 * The stations MTA lists a line at in the daytime.
 *
 * daytime_routes holds display names, so the three shuttles all appear as "S"
 * and this returns every shuttle station for any of them. lineSections keeps
 * only the ones a line's own trips stop at, which sorts them out.
 *
 * @param {Array<{gtfs_stop_id: string, daytime_routes?: string}>} stations rows of stations.json
 * @param {string} name the line's route_short_name
 * @returns {Set<string>}
 */
export function daytimeStations(stations, name) {
    const ids = new Set();
    for (const row of stations) {
        if ((row.daytime_routes ?? '').split(/\s+/).includes(name)) ids.add(row.gtfs_stop_id);
    }
    return ids;
}

/**
 * A line's daytime stations in order, split into sections where it branches.
 *
 * Every pattern contributes its daytime stations, linked to the next daytime
 * station it visits. A link that skips stations another link reaches anyway is
 * an express hop or a skip-stop run, and is dropped, so the order that's left
 * is the full local one. Wherever more than one link leaves or arrives, a
 * section ends and the next begins, so a junction station is the last stop of
 * one section and the first of the next.
 *
 * Sections come out from the north end, and where two begin at the same place
 * the longer one comes first. If the links ever loop back on themselves there
 * is no order to give, so this falls back to the longest pattern and says so.
 *
 * @param {string[][]} patterns from linePatterns
 * @param {Set<string>} daytime from daytimeStations
 * @returns {{sections: string[][], fallback: boolean}}
 */
export function lineSections(patterns, daytime) {
    const kept = patterns.map(p => p.filter(id => daytime.has(id)));
    const next = new Map();
    for (const ids of kept) {
        for (const id of ids) if (!next.has(id)) next.set(id, new Set());
        for (let i = 1; i < ids.length; i++) next.get(ids[i - 1]).add(ids[i]);
    }

    const order = topologicalOrder(next);
    if (!order) {
        const longest = kept.reduce((best, ids) => (ids.length > best.length ? ids : best), []);
        return { sections: longest.length ? [longest] : [], fallback: true };
    }

    dropShortcuts(next);

    const rank = new Map(order.map((id, i) => [id, i]));
    const arriving = new Map(order.map(id => [id, 0]));
    for (const outs of next.values()) for (const id of outs) arriving.set(id, arriving.get(id) + 1);
    const isJunction = (id) => arriving.get(id) !== 1 || next.get(id).size !== 1;
    const byRank = (a, b) => rank.get(a) - rank.get(b);

    const sections = [];
    for (const start of order) {
        if (!isJunction(start)) continue;
        if (next.get(start).size === 0 && arriving.get(start) === 0) sections.push([start]);
        for (const first of [...next.get(start)].sort(byRank)) {
            const section = [start, first];
            let at = first;
            while (!isJunction(at)) {
                at = [...next.get(at)][0];
                section.push(at);
            }
            sections.push(section);
        }
    }

    sections.sort((a, b) => byRank(a[0], b[0]) || b.length - a.length);
    return { sections, fallback: false };
}

/**
 * The stations either side of one station on a line, from its sections.
 *
 * prev is toward the north end and next away from it. A junction has more than
 * one on its branching side. A station the line doesn't stop at gets two empty
 * lists.
 *
 * @param {string[][]} sections from lineSections
 * @param {string} stationId
 * @returns {{prev: string[], next: string[]}}
 */
export function neighbors(sections, stationId) {
    const prev = new Set();
    const next = new Set();
    for (const section of sections ?? []) {
        const i = section.indexOf(stationId);
        if (i < 0) continue;
        if (i > 0) prev.add(section[i - 1]);
        if (i < section.length - 1) next.add(section[i + 1]);
    }
    return { prev: [...prev], next: [...next] };
}

/**
 * Which kinds of day each service id runs on, from calendar.txt.
 *
 * @param {Array<object>} calendar rows of calendar.txt
 * @returns {Map<string, Set<string>>} service id → some of DAY_TYPES
 */
export function serviceDays(calendar) {
    const days = new Map();
    for (const row of calendar ?? []) {
        const set = new Set();
        if (WEEKDAYS.some(d => row[d] === '1')) set.add('weekday');
        if (row.saturday === '1') set.add('saturday');
        if (row.sunday === '1') set.add('sunday');
        days.set(row.service_id, set);
    }
    return days;
}

/**
 * When each line runs, from its scheduled stop times.
 *
 * `night` is true when every one of the line's daytime stations has trains
 * between 1 and 5 AM, false when none does, and otherwise the stations that do,
 * in the line's order: the 5 runs all night, but only between Eastchester-Dyre
 * Av and E 180 St. `spans` is kept only for lines that stop at night, since
 * those are the only ones whose hours need spelling out: minutes after midnight
 * on the service day, so a train at 12:15 AM on a weekday's late run is 1455.
 *
 * @param {Array<object>} stopTimes rows of stop_times.txt
 * @param {Array<object>} trips rows of trips.txt
 * @param {Array<object>} stops rows of stops.txt
 * @param {Array<object>} calendar rows of calendar.txt
 * @param {Map<string, string[]>} daytimeByLine each line's daytime stations, in order
 * @returns {Map<string, {days: string[], night: boolean|string[], spans?: Object<string, number[][]>}>}
 */
export function lineHours(stopTimes, trips, stops, calendar, daytimeByLine) {
    const parentOf = new Map(stops.map(s => [s.stop_id, s.parent_station || s.stop_id]));
    const tripById = new Map(trips.map(t => [t.trip_id, t]));
    const days = serviceDays(calendar);

    const running = new Map();
    const atNight = new Map();
    for (const st of stopTimes) {
        const trip = tripById.get(st.trip_id);
        const minutes = toMinutes(st.departure_time || st.arrival_time);
        if (!trip || minutes === null) continue;
        const line = expressParent(trip.route_id) ?? trip.route_id;

        let byDay = running.get(line);
        if (!byDay) running.set(line, byDay = new Map());
        for (const day of days.get(trip.service_id) ?? []) {
            if (!byDay.has(day)) byDay.set(day, new Set());
            byDay.get(day).add(Math.floor(minutes / BUCKET));
        }

        const clock = minutes % 1440;
        if (clock >= NIGHT_START && clock < NIGHT_END) {
            if (!atNight.has(line)) atNight.set(line, new Set());
            atNight.get(line).add(parentOf.get(st.stop_id) ?? st.stop_id);
        }
    }

    const hours = new Map();
    for (const [line, byDay] of running) {
        const daytime = daytimeByLine.get(line) ?? [];
        const nightSet = atNight.get(line) ?? new Set();
        const served = daytime.filter(id => nightSet.has(id));
        const night = served.length === 0 ? false : served.length === daytime.length ? true : served;

        const entry = { days: DAY_TYPES.filter(d => byDay.has(d)), night };
        if (night === false) {
            entry.spans = Object.fromEntries(entry.days.map(d => [d, spansOf(byDay.get(d))]));
        }
        hours.set(line, entry);
    }
    return hours;
}

/**
 * Every line's sections and hours, from the parsed feed and stations.json.
 *
 * Lines with no daytime stations at all are left out and listed in `empty`,
 * rather than failing, so a temporary route MTA adds to the feed can't break
 * the build. Lines that fell back to their longest pattern are listed in
 * `fallbacks`. Hours are added only when calendar.txt is given.
 *
 * @param {{stopTimes: object[], trips: object[], stops: object[], routes: object[], stations: object[], calendar?: object[]}} feed
 * @returns {{lines: Object<string, {sections: string[][], hours?: object}>, fallbacks: string[], empty: string[]}}
 */
export function buildLineOrder({ stopTimes, trips, stops, routes, stations, calendar = [] }) {
    const shortName = new Map(routes.map(r => [r.route_id, r.route_short_name || r.route_id]));
    const lines = {};
    const fallbacks = [];
    const empty = [];

    const patterns = [...linePatterns(stopTimes, trips, stops)].sort(([a], [b]) => a.localeCompare(b));
    for (const [line, linePats] of patterns) {
        const daytime = daytimeStations(stations, shortName.get(line) ?? line);
        const { sections, fallback } = lineSections(linePats, daytime);
        if (fallback) fallbacks.push(line);
        if (sections.length) lines[line] = { sections };
        else empty.push(line);
    }

    if (calendar.length) {
        const daytimeByLine = new Map(Object.entries(lines).map(([line, { sections }]) => [line, [...new Set(sections.flat())]]));
        for (const [line, hours] of lineHours(stopTimes, trips, stops, calendar, daytimeByLine)) {
            if (lines[line]) lines[line].hours = hours;
        }
    }

    return { lines, fallbacks, empty };
}

// "25:30:00" → 1530. GTFS counts past 24 hours for trips that run after
// midnight on the previous day's service.
function toMinutes(time) {
    const match = /^(\d+):(\d\d)/.exec(time ?? '');
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// Quarter hours with trains → [start, end] spans in minutes, joining pauses
// shorter than MIN_BREAK.
function spansOf(buckets) {
    const sorted = [...(buckets ?? [])].sort((a, b) => a - b);
    const spans = [];
    for (const b of sorted) {
        const last = spans.at(-1);
        if (last && b * BUCKET - last[1] < MIN_BREAK) last[1] = (b + 1) * BUCKET;
        else spans.push([b * BUCKET, (b + 1) * BUCKET]);
    }
    return spans;
}

// Kahn's algorithm, taking the lowest station id first whenever there's a
// choice, so the same feed always gives the same order. Null when the links
// loop back on themselves.
function topologicalOrder(next) {
    const arriving = new Map([...next.keys()].map(id => [id, 0]));
    for (const outs of next.values()) for (const id of outs) arriving.set(id, arriving.get(id) + 1);

    const ready = [...arriving].filter(([, n]) => n === 0).map(([id]) => id).sort();
    const order = [];
    while (ready.length) {
        const id = ready.shift();
        order.push(id);
        for (const to of next.get(id)) {
            arriving.set(to, arriving.get(to) - 1);
            if (arriving.get(to) === 0) {
                ready.push(to);
                ready.sort();
            }
        }
    }
    return order.length === next.size ? order : null;
}

// Removes a → c wherever c can still be reached from a through some other
// station: on a graph with no loops, those links are exactly the express hops.
function dropShortcuts(next) {
    for (const [from, outs] of next) {
        for (const to of [...outs]) {
            if (reachableAvoiding(next, from, to)) outs.delete(to);
        }
    }
}

function reachableAvoiding(next, from, to) {
    const stack = [...next.get(from)].filter(id => id !== to);
    const seen = new Set(stack);
    while (stack.length) {
        const id = stack.pop();
        for (const after of next.get(id)) {
            if (after === to) return true;
            if (!seen.has(after)) {
                seen.add(after);
                stack.push(after);
            }
        }
    }
    return false;
}
