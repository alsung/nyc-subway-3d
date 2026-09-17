// src/core/train-motion.js
// Where a train is right now, from MTA's predicted stop times.
//
// The feed publishes no GPS. What it does publish, on 99% of stop-time updates,
// is a predicted arrival and departure for each of the next few stops, and those
// are enough to place a train continuously: if it left A at 12:00:30 and is due
// at B at 12:02:15, then at 12:01:22 it is a little past halfway.
//
// Deliberately ignores currentStatus, which cannot support this. 45% of vehicles
// omit the field entirely and are defaulted to STOPPED_AT, so that value is a
// dumping ground: on one live snapshot, 176 of the 596 vehicles reporting
// STOPPED_AT had a next arrival more than ten minutes away. The timestamps
// describe themselves and need no such interpretation.

// How far ahead of a train's own stop we are still willing to guess.
//
// A window is anchored on the stop the vehicle is at or heading to, so when that
// arrival is still in the future the train is somewhere behind it and the feed
// does not say where — 188 of 220 vehicles have their stop at index 0, with no
// previous stop published. Inside a few minutes, backing off at the speed of the
// upcoming hop is a fair estimate. Beyond it, the vehicle is usually a run that
// has not started: on the same snapshot, 176 vehicles had arrivals more than ten
// minutes out, most sitting at terminals. Those get no position from here.
const APPROACH_MAX_SECONDS = 180;

// Arrival and departure, with each standing in for the other when the feed omits
// one — which it does on roughly 1-3% of stops, typically at a trip's ends.
const arrivalOf = (stop) => stop?.arrival || stop?.departure || null;
const departureOf = (stop) => stop?.departure || stop?.arrival || null;

/**
 * Where a train sits along its route, as a pair of stops and a fraction.
 *
 * The caller turns this into a position with a single lerp between the two
 * stops' known places on the line:
 *
 *     u = u(fromStopId) + t * (u(toStopId) - u(fromStopId))
 *
 * One formula covers all three cases, because t is allowed outside [0, 1]:
 *
 *   t === 0              stopped at fromStopId (also when from === to)
 *   0 < t < 1            in transit between them
 *   -1 <= t < 0          short of fromStopId, extrapolating backward along the
 *                        same line at the speed of the hop ahead
 *
 * `seconds` is how long the feed says that interval takes, so a caller holding
 * the distance can check the implied speed before believing it. Zero at a stop.
 *
 * @param {{stopId: string, arrival?: number, departure?: number}[]} window
 *   the vehicle's stop sequence, anchored on its own stop
 * @param {number} now epoch seconds
 * @returns {{fromStopId: string, toStopId: string, t: number}|null}
 *   null when the feed does not support placing this train, which means "leave
 *   it wherever the snapshot put it" rather than "hide it"
 */
export function positionAt(window, now) {
    if (!Array.isArray(window) || window.length === 0) return null;
    if (!Number.isFinite(now)) return null;

    // Only stops the feed gave a time to can bound an interval. Filtering first
    // rather than pairing each stop with its immediate neighbour matters: a
    // timeless stop mid-window would otherwise break the chain, and a train
    // between the stops either side of it would fall through to the end of the
    // window and be parked at its last stop.
    const timed = window
        .filter(stop => arrivalOf(stop) != null)
        .map(stop => ({
            stopId: stop.stopId,
            arrival: arrivalOf(stop),
            departure: departureOf(stop),
        }));
    if (timed.length === 0) return null;

    const first = timed[0];

    // Still short of its own stop.
    if (now < first.arrival) {
        const lead = first.arrival - now;
        if (lead > APPROACH_MAX_SECONDS) return null;

        const next = timed[1];
        // With no hop ahead there is no speed to borrow, so the best available
        // answer is the stop itself.
        if (!next || next.arrival <= first.departure) {
            return { fromStopId: first.stopId, toStopId: first.stopId, t: 0, seconds: 0 };
        }

        const hop = next.arrival - first.departure;
        return {
            fromStopId: first.stopId,
            toStopId: next.stopId,
            t: -Math.min(1, lead / hop),
            seconds: hop,
        };
    }

    for (let i = 0; i < timed.length; i++) {
        const stop = timed[i];

        // Dwelling. Rare — MTA publishes an identical arrival and departure on
        // 91% of stops — but real where the two differ.
        if (now >= stop.arrival && now <= stop.departure) {
            return { fromStopId: stop.stopId, toStopId: stop.stopId, t: 0, seconds: 0 };
        }

        const next = timed[i + 1];
        if (!next) break;

        if (now > stop.departure && now < next.arrival) {
            const hop = next.arrival - stop.departure;
            return {
                fromStopId: stop.stopId,
                toStopId: next.stopId,
                t: hop > 0 ? (now - stop.departure) / hop : 0,
                seconds: hop,
            };
        }
    }

    // Past everything the window describes. Hold at its last stop rather than
    // extrapolating off the end of a prediction that has run out.
    const last = timed[timed.length - 1];
    return { fromStopId: last.stopId, toStopId: last.stopId, t: 0, seconds: 0 };
}
