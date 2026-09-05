import { describe, it, expect } from 'vitest';
import { TRUNKS, trunksFor, bulletRoutes } from '../../src/core/trunks.js';
import { TRUNK_ORDER } from '../../src/core/alert-status.js';

// The 29 route ids the MTA static feed actually ships, verified against
// public/gtfs/routes.txt. Hard-coded so a change in the feed fails a test
// rather than silently dropping a line out of the filter.
const REAL_ROUTE_IDS = [
    'A', 'C', 'E', 'B', 'D', 'F', 'FX', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q',
    'R', 'W', 'GS', 'FS', 'H', '1', '2', '3', '4', '5', '6', '6X', '7', '7X', 'SI',
];

const routeMapOf = (ids) => Object.fromEntries(ids.map(id => [id, { id, shortName: id }]));

describe('TRUNKS', () => {
    it('covers every route in the real feed exactly once', () => {
        const listed = TRUNKS.flatMap(t => t.routeIds);
        expect(new Set(listed).size).toBe(listed.length);
        expect([...listed].sort()).toEqual([...REAL_ROUTE_IDS].sort());
    });

    it('lists trunks in the same order as the alerts panel', () => {
        expect(TRUNKS.map(t => t.key)).toEqual(TRUNK_ORDER);
    });

    it('folds express variants into their parent trunk', () => {
        const parentOf = (id) => TRUNKS.find(t => t.routeIds.includes(id))?.key;
        expect(parentOf('FX')).toBe(parentOf('F'));
        expect(parentOf('6X')).toBe(parentOf('6'));
        expect(parentOf('7X')).toBe(parentOf('7'));
    });

    it('groups the three shuttles together', () => {
        const s = TRUNKS.find(t => t.key === 'S');
        expect(s.routeIds).toEqual(['GS', 'FS', 'H']);
    });
});

describe('bulletRoutes', () => {
    it('drops express patterns that share a parent line', () => {
        expect(bulletRoutes(['B', 'D', 'F', 'FX', 'M'])).toEqual(['B', 'D', 'F', 'M']);
        expect(bulletRoutes(['4', '5', '6', '6X'])).toEqual(['4', '5', '6']);
        expect(bulletRoutes(['7', '7X'])).toEqual(['7']);
    });

    it('leaves trunks without express patterns untouched', () => {
        expect(bulletRoutes(['A', 'C', 'E'])).toEqual(['A', 'C', 'E']);
        expect(bulletRoutes(['GS', 'FS', 'H'])).toEqual(['GS', 'FS', 'H']);
    });

    it('falls back to the full list rather than rendering no bullets', () => {
        expect(bulletRoutes(['7X'])).toEqual(['7X']);
    });

    it('handles empty and missing input', () => {
        expect(bulletRoutes([])).toEqual([]);
        expect(bulletRoutes(undefined)).toEqual([]);
    });
});

describe('trunksFor', () => {
    it('returns all eleven trunks for the real feed', () => {
        const out = trunksFor(routeMapOf(REAL_ROUTE_IDS));
        expect(out.map(t => t.key)).toEqual(TRUNK_ORDER);
        expect(out.flatMap(t => t.routeIds).sort()).toEqual([...REAL_ROUTE_IDS].sort());
    });

    it('omits trunks whose routes are absent rather than showing empty rows', () => {
        const out = trunksFor(routeMapOf(['A', 'C', 'E', 'L']));
        expect(out.map(t => t.key)).toEqual(['ACE', 'L']);
    });

    it('lists only the routes actually present within a trunk', () => {
        const out = trunksFor(routeMapOf(['B', 'F']));
        expect(out).toEqual([{ key: 'BDFM', routeIds: ['B', 'F'] }]);
    });

    it('collects unknown route ids into a trailing Other trunk', () => {
        const out = trunksFor(routeMapOf(['A', 'X99']));
        expect(out).toEqual([
            { key: 'ACE', routeIds: ['A'] },
            { key: 'Other', routeIds: ['X99'] },
        ]);
    });

    it('adds no Other trunk when every route is known', () => {
        const out = trunksFor(routeMapOf(REAL_ROUTE_IDS));
        expect(out.some(t => t.key === 'Other')).toBe(false);
    });

    it('handles an empty or missing routeMap', () => {
        expect(trunksFor({})).toEqual([]);
        expect(trunksFor(undefined)).toEqual([]);
    });
});
