import { describe, it, expect } from 'vitest';
import { positionAt } from '../../src/core/train-motion.js';

const T = 1_700_000_000;

// A window of stops at 120s spacing with no dwell, which is what MTA actually
// publishes: arrival equals departure on 91% of stops.
const window = (ids, start = T, gap = 120) =>
    ids.map((stopId, i) => ({ stopId, arrival: start + i * gap, departure: start + i * gap }));

describe('positionAt in transit', () => {
    const w = window(['A', 'B', 'C', 'D']);

    it('places a train by wall clock between two stops', () => {
        expect(positionAt(w, T + 30)).toEqual({ fromStopId: 'A', toStopId: 'B', t: 0.25, seconds: 120 });
        expect(positionAt(w, T + 60)).toEqual({ fromStopId: 'A', toStopId: 'B', t: 0.5, seconds: 120 });
        expect(positionAt(w, T + 90)).toEqual({ fromStopId: 'A', toStopId: 'B', t: 0.75, seconds: 120 });
    });

    it('moves through the whole window as time passes', () => {
        expect(positionAt(w, T + 150)).toMatchObject({ fromStopId: 'B', toStopId: 'C' });
        expect(positionAt(w, T + 270)).toMatchObject({ fromStopId: 'C', toStopId: 'D' });
    });

    it('snaps to a stop at the moment it arrives', () => {
        expect(positionAt(w, T + 120)).toEqual({ fromStopId: 'B', toStopId: 'B', t: 0, seconds: 0 });
    });

    it('holds at the last stop rather than running off the end', () => {
        // The prediction has run out; extrapolating past it would invent a
        // position on a line the window says nothing about.
        expect(positionAt(w, T + 10_000)).toEqual({ fromStopId: 'D', toStopId: 'D', t: 0, seconds: 0 });
    });
});

describe('positionAt dwelling', () => {
    it('holds at the stop between arrival and departure', () => {
        const w = [
            { stopId: 'A', arrival: T, departure: T + 45 },
            { stopId: 'B', arrival: T + 165, departure: T + 165 },
        ];
        expect(positionAt(w, T + 20)).toEqual({ fromStopId: 'A', toStopId: 'A', t: 0, seconds: 0 });
        // Motion starts from the departure, not the arrival.
        expect(positionAt(w, T + 105)).toMatchObject({ fromStopId: 'A', toStopId: 'B', t: 0.5 });
    });
});

describe('positionAt approaching its own stop', () => {
    // The window is anchored on the vehicle's stop, so when that arrival is
    // still ahead there is no previous stop to interpolate from. The fraction
    // is negative, which extrapolates backward along the same line.
    const w = window(['A', 'B', 'C']);

    it('returns a negative fraction scaled by the hop ahead', () => {
        // 60s short of A, against a 120s hop: one half of a hop behind it.
        expect(positionAt(w, T - 60)).toEqual({ fromStopId: 'A', toStopId: 'B', t: -0.5, seconds: 120 });
    });

    it('never backs off further than one whole hop', () => {
        expect(positionAt(w, T - 170).t).toBe(-1);
    });

    it('gives up beyond the approach window', () => {
        // Past three minutes these are overwhelmingly runs that have not
        // started, sitting at a terminal. Guessing would be worse than not.
        expect(positionAt(w, T - 181)).toBeNull();
    });

    it('falls back to the stop itself when there is no hop to borrow', () => {
        const single = [{ stopId: 'A', arrival: T, departure: T }];
        expect(positionAt(single, T - 30)).toEqual({ fromStopId: 'A', toStopId: 'A', t: 0, seconds: 0 });
    });
});

describe('positionAt degraded input', () => {
    it('returns null rather than a guess', () => {
        expect(positionAt([], T)).toBeNull();
        expect(positionAt(null, T)).toBeNull();
        expect(positionAt(window(['A']), NaN)).toBeNull();
        // A stop with no times at all cannot anchor anything.
        expect(positionAt([{ stopId: 'A' }], T)).toBeNull();
    });

    it('reads one time as the other when the feed omits it', () => {
        // The 1-3% at a trip's ends carry arrival or departure, not both.
        const w = [
            { stopId: 'A', departure: T },
            { stopId: 'B', arrival: T + 120 },
        ];
        expect(positionAt(w, T + 60)).toEqual({ fromStopId: 'A', toStopId: 'B', t: 0.5, seconds: 120 });
    });

    it('skips a timeless stop mid-window instead of stalling on it', () => {
        const w = [
            { stopId: 'A', arrival: T, departure: T },
            { stopId: 'B' },
            { stopId: 'C', arrival: T + 240, departure: T + 240 },
        ];
        // A -> C directly: B says nothing, so it cannot bound an interval.
        expect(positionAt(w, T + 120)).toMatchObject({ fromStopId: 'A', toStopId: 'C' });
    });
});
