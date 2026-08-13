import { describe, it, expect } from 'vitest';
import {
    mergeArrivalResults,
    isArrivalsStale,
    formatAge,
    ARRIVALS_STALE_MS,
} from '../../src/core/arrivals.js';

const ok = (arrivals, updatedAt = '2026-08-13T06:00:00Z') =>
    ({ status: 'fulfilled', value: { arrivals, updatedAt } });
const fail = () => ({ status: 'rejected', reason: new Error('boom') });

const a = (tripId, minutes, direction = 'N', routeId = '1') =>
    ({ tripId, minutes, direction, routeId });

// ── status ────────────────────────────────────────────────────────────────────

describe('mergeArrivalResults — status', () => {
    it('is ok when every request succeeds and there are arrivals', () => {
        const r = mergeArrivalResults([ok([a('t1', 3)]), ok([a('t2', 5)])]);
        expect(r.status).toBe('ok');
        expect(r.failedCount).toBe(0);
    });

    it('is empty when every request succeeds with no arrivals', () => {
        const r = mergeArrivalResults([ok([]), ok([])]);
        expect(r.status).toBe('empty');
        expect(r.arrivals).toEqual([]);
    });

    it('is error when every request fails', () => {
        const r = mergeArrivalResults([fail(), fail()]);
        expect(r.status).toBe('error');
        expect(r.failedCount).toBe(2);
        expect(r.updatedAt).toBeNull();
    });

    it('is partial when some requests fail but arrivals remain', () => {
        const r = mergeArrivalResults([ok([a('t1', 3)]), fail()]);
        expect(r.status).toBe('partial');
        expect(r.failedCount).toBe(1);
        expect(r.arrivals).toHaveLength(1);
    });

    it('is empty, not partial, when survivors have no arrivals', () => {
        // Nothing to show either way, so the honest label is "no trains" with
        // the failure count still available to the caller.
        const r = mergeArrivalResults([ok([]), fail()]);
        expect(r.status).toBe('empty');
        expect(r.failedCount).toBe(1);
    });

    it('treats a fulfilled-but-empty value as failed', () => {
        const r = mergeArrivalResults([{ status: 'fulfilled', value: null }]);
        expect(r.status).toBe('error');
    });

    it('handles an empty input list', () => {
        const r = mergeArrivalResults([]);
        expect(r.status).toBe('error');
        expect(r.requestCount).toBe(0);
    });
});

// ── merging ───────────────────────────────────────────────────────────────────

describe('mergeArrivalResults — merging', () => {
    it('dedupes by tripId across stations of a complex', () => {
        const r = mergeArrivalResults([ok([a('same', 4)]), ok([a('same', 4)])]);
        expect(r.arrivals).toHaveLength(1);
    });

    it('sorts ascending by minutes', () => {
        const r = mergeArrivalResults([ok([a('t1', 9), a('t2', 1)]), ok([a('t3', 5)])]);
        expect(r.arrivals.map(x => x.minutes)).toEqual([1, 5, 9]);
    });

    it('keeps negative minutes ahead of zero', () => {
        const r = mergeArrivalResults([ok([a('t1', 0), a('t2', -1)])]);
        expect(r.arrivals.map(x => x.minutes)).toEqual([-1, 0]);
    });

    it('tolerates a missing arrivals array', () => {
        const r = mergeArrivalResults([{ status: 'fulfilled', value: { updatedAt: null } }]);
        expect(r.status).toBe('empty');
    });

    it('takes the oldest updatedAt among successes', () => {
        const r = mergeArrivalResults([
            ok([a('t1', 2)], '2026-08-13T06:00:30Z'),
            ok([a('t2', 4)], '2026-08-13T06:00:00Z'),
        ]);
        expect(r.updatedAt).toBe('2026-08-13T06:00:00.000Z');
    });

    it('ignores unparseable timestamps rather than trusting them', () => {
        const r = mergeArrivalResults([ok([a('t1', 2)], 'not-a-date')]);
        expect(r.updatedAt).toBeNull();
    });
});

// ── staleness ─────────────────────────────────────────────────────────────────

describe('isArrivalsStale', () => {
    const now = Date.parse('2026-08-13T06:00:00Z');

    it('is fresh within the window', () => {
        expect(isArrivalsStale(new Date(now - 10_000).toISOString(), now)).toBe(false);
    });

    it('is stale past the window', () => {
        expect(isArrivalsStale(new Date(now - ARRIVALS_STALE_MS - 1).toISOString(), now)).toBe(true);
    });

    it('treats a missing timestamp as stale', () => {
        expect(isArrivalsStale(null, now)).toBe(true);
    });

    it('treats an unparseable timestamp as stale', () => {
        expect(isArrivalsStale('nonsense', now)).toBe(true);
    });
});

// ── formatAge ─────────────────────────────────────────────────────────────────

describe('formatAge', () => {
    const now = Date.parse('2026-08-13T06:00:00Z');
    const ago = ms => new Date(now - ms).toISOString();

    it('says just now under a minute', () => {
        expect(formatAge(ago(30_000), now)).toBe('just now');
    });

    it('reports minutes', () => {
        expect(formatAge(ago(5 * 60_000), now)).toBe('5 min ago');
    });

    it('reports hours', () => {
        expect(formatAge(ago(2 * 3_600_000), now)).toBe('2 hr ago');
    });

    it('never reports a negative age from clock skew', () => {
        expect(formatAge(new Date(now + 30_000).toISOString(), now)).toBe('just now');
    });

    it('handles a missing timestamp', () => {
        expect(formatAge(null, now)).toBe('unknown');
    });
});
