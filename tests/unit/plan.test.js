import { describe, it, expect } from 'vitest';
import {
    clockToMinutes, formatClock, formatDuration, formatTransfers,
    ridesOf, usesRealtime, normalizePlan, describeLeg, legMinutes,
    MAX_REASONABLE_MINUTES,
} from '../../src/core/plan.js';

// A response shaped like the API's, small enough to reason about.
const response = {
    from: '127', to: '631', feedAgeSeconds: 18,
    journeys: [
        {
            transfers: 1, departAt: '13:33:30', arriveAt: '13:52:00', minutes: 19,
            legs: [
                { kind: 'walk', fromStop: '127N', toStop: '725N', departAt: '13:29:49', arriveAt: '13:32:49', timing: 'scheduled' },
                { kind: 'ride', routeId: '7', fromStop: '725N', toStop: '723N', departAt: '13:33:30', arriveAt: '13:39:30', stops: ['725N', '724N', '723N'], timing: 'realtime' },
                { kind: 'ride', routeId: '6', fromStop: '723N', toStop: '631N', departAt: '13:44:00', arriveAt: '13:52:00', stops: ['723N', '631N'], timing: 'scheduled' },
            ],
        },
    ],
};

describe('clockToMinutes', () => {
    it('parses the API clock format', () => {
        expect(clockToMinutes('13:39:30')).toBe(13 * 60 + 39);
        expect(clockToMinutes('00:00:00')).toBe(0);
        expect(clockToMinutes('9:05')).toBe(9 * 60 + 5);
    });

    it('accepts service-day hours past 24', () => {
        // GTFS writes a 1:30am train as 25:30 — it belongs to the previous
        // service day. Rejecting it would drop the late-night network.
        expect(clockToMinutes('25:30:00')).toBe(25 * 60 + 30);
        expect(clockToMinutes('28:02:00')).toBe(28 * 60 + 2);
    });

    it('returns null rather than NaN for anything unparseable', () => {
        // NaN propagates silently into arithmetic and renders as "NaN min".
        // The server produced an 809-minute journey the same way.
        for (const bad of ['', '  ', 'noon', '13', '13:XX', '13:75:00', null, undefined]) {
            expect(clockToMinutes(bad)).toBeNull();
        }
    });
});

describe('formatClock', () => {
    it('renders a 12-hour clock', () => {
        expect(formatClock('13:39:30')).toBe('1:39 PM');
        expect(formatClock('09:05:00')).toBe('9:05 AM');
        expect(formatClock('00:15:00')).toBe('12:15 AM');
        expect(formatClock('12:00:00')).toBe('12:00 PM');
    });

    it('wraps a service-day hour rather than printing 25:30 PM', () => {
        expect(formatClock('25:30:00')).toBe('1:30 AM');
        expect(formatClock('24:00:00')).toBe('12:00 AM');
    });

    it('renders nothing for a missing time', () => {
        expect(formatClock(undefined)).toBe('');
        expect(formatClock('garbage')).toBe('');
    });
});

describe('formatDuration', () => {
    it('reads as a rider would say it', () => {
        expect(formatDuration(6)).toBe('6 min');
        expect(formatDuration(59)).toBe('59 min');
        expect(formatDuration(60)).toBe('1 hr');
        expect(formatDuration(95)).toBe('1 hr 35 min');
        expect(formatDuration(120)).toBe('2 hr');
    });

    it('renders nothing for a missing or negative duration', () => {
        expect(formatDuration(undefined)).toBe('');
        expect(formatDuration(NaN)).toBe('');
        expect(formatDuration(-4)).toBe('');
    });
});

describe('formatTransfers', () => {
    it('says Direct rather than 0 transfers', () => {
        expect(formatTransfers(0)).toBe('Direct');
        expect(formatTransfers(undefined)).toBe('Direct');
    });

    it('singularises one', () => {
        expect(formatTransfers(1)).toBe('1 transfer');
        expect(formatTransfers(2)).toBe('2 transfers');
    });
});

describe('ridesOf', () => {
    it('lists the routes ridden, skipping walks', () => {
        expect(ridesOf(response.journeys[0])).toEqual(['7', '6']);
    });

    it('survives a journey with no legs', () => {
        expect(ridesOf(null)).toEqual([]);
        expect(ridesOf({})).toEqual([]);
    });
});

describe('usesRealtime', () => {
    it('is true when any leg was planned on live data', () => {
        expect(usesRealtime(response.journeys[0])).toBe(true);
    });

    it('is false when every leg is scheduled', () => {
        const scheduled = { legs: [{ timing: 'scheduled' }, { timing: 'scheduled' }] };
        expect(usesRealtime(scheduled)).toBe(false);
        expect(usesRealtime(null)).toBe(false);
    });
});

describe('legMinutes', () => {
    it('measures a leg from its own times', () => {
        expect(legMinutes(response.journeys[0].legs[0])).toBe(3);
        expect(legMinutes(response.journeys[0].legs[1])).toBe(6);
    });

    it('handles a leg crossing midnight', () => {
        expect(legMinutes({ departAt: '23:50:00', arriveAt: '00:05:00' })).toBe(15);
    });

    it('is zero when times are missing rather than NaN', () => {
        expect(legMinutes({})).toBe(0);
        expect(legMinutes(null)).toBe(0);
    });
});

describe('describeLeg', () => {
    const nameOf = (id) => ({ '725N': 'Times Sq-42 St', '723N': 'Grand Central-42 St', '631N': '51 St' }[id] ?? id);

    it('describes a walk by its duration and destination', () => {
        expect(describeLeg(response.journeys[0].legs[0], nameOf)).toBe('Walk 3 min to Times Sq-42 St');
    });

    it('describes a ride by how many stops it is', () => {
        // Three stop ids is two stops travelled, which is what a rider counts.
        expect(describeLeg(response.journeys[0].legs[1], nameOf)).toBe('2 stops to Grand Central-42 St');
    });

    it('singularises one stop', () => {
        expect(describeLeg(response.journeys[0].legs[2], nameOf)).toBe('1 stop to 51 St');
    });

    it('falls back to the stop id when no name is known', () => {
        expect(describeLeg({ kind: 'ride', toStop: 'X99', stops: ['A', 'X99'] })).toBe('1 stop to X99');
    });

    it('survives a missing leg', () => {
        expect(describeLeg(null)).toBe('');
    });
});

describe('normalizePlan', () => {
    it('shapes a response for the panel', () => {
        const { journeys, feedAgeSeconds } = normalizePlan(response);
        expect(journeys).toHaveLength(1);
        expect(journeys[0]).toMatchObject({
            minutes: 19, transfers: 1, rides: ['7', '6'], realtime: true,
        });
        expect(feedAgeSeconds).toBe(18);
    });

    it('drops journeys it cannot display honestly', () => {
        const { journeys } = normalizePlan({
            journeys: [
                { minutes: 10, transfers: 0, legs: [{ kind: 'ride', routeId: '1' }] },
                { minutes: 0, transfers: 0, legs: [{ kind: 'ride' }] },           // zero duration
                { minutes: 12, transfers: 0, legs: [] },                          // no legs
                { minutes: MAX_REASONABLE_MINUTES + 1, transfers: 0, legs: [{}] }, // absurd
                { minutes: NaN, transfers: 0, legs: [{}] },                       // unparseable
            ],
        });
        expect(journeys).toHaveLength(1);
        expect(journeys[0].minutes).toBe(10);
    });

    it('preserves the order the API returned', () => {
        // RAPTOR returns fewest transfers first and fastest last. Re-sorting
        // here would discard the Pareto ordering it computed.
        const { journeys } = normalizePlan({
            journeys: [
                { minutes: 30, transfers: 0, legs: [{ kind: 'ride', routeId: 'A' }] },
                { minutes: 22, transfers: 1, legs: [{ kind: 'ride', routeId: 'B' }] },
                { minutes: 18, transfers: 2, legs: [{ kind: 'ride', routeId: 'C' }] },
            ],
        });
        expect(journeys.map(j => j.transfers)).toEqual([0, 1, 2]);
        expect(journeys.map(j => j.minutes)).toEqual([30, 22, 18]);
    });

    it('reports a missing feed age as -1 rather than guessing', () => {
        expect(normalizePlan({ journeys: [] }).feedAgeSeconds).toBe(-1);
        expect(normalizePlan({}).feedAgeSeconds).toBe(-1);
        expect(normalizePlan(null).feedAgeSeconds).toBe(-1);
    });

    it('survives a malformed response', () => {
        expect(normalizePlan(null).journeys).toEqual([]);
        expect(normalizePlan({ journeys: 'nope' }).journeys).toEqual([]);
    });
});
