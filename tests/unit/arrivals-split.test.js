import { describe, it, expect } from 'vitest';
import { splitByDirection, trunksInArrivals, soonestMinutes, minutesText } from '../../src/core/arrivals.js';

const a = (routeId, direction, minutes, destination = 'X') =>
    ({ routeId, direction, minutes, destination, tripId: `${routeId}-${minutes}` });

describe('splitByDirection', () => {
    it('separates the two platform directions', () => {
        const out = splitByDirection([a('1', 'N', 5), a('1', 'S', 3)]);
        expect(out.N.map(x => x.minutes)).toEqual([5]);
        expect(out.S.map(x => x.minutes)).toEqual([3]);
    });

    // The behavior the redesign is for: a rider boards whichever train comes
    // first, so routes interleave instead of being listed one line at a time.
    it('interleaves routes by arrival time', () => {
        const out = splitByDirection([
            a('2', 'N', 4), a('1', 'N', 3), a('3', 'N', 6), a('1', 'N', 11),
        ]);
        expect(out.N.map(x => `${x.routeId}@${x.minutes}`))
            .toEqual(['1@3', '2@4', '3@6', '1@11']);
    });

    it('narrows to one trunk when route ids are given', () => {
        const out = splitByDirection(
            [a('1', 'N', 3), a('R', 'N', 4), a('2', 'N', 5)], ['1', '2', '3'],
        );
        expect(out.N.map(x => x.routeId)).toEqual(['1', '2']);
    });

    it('keeps every route when no filter is given', () => {
        const out = splitByDirection([a('1', 'N', 3), a('R', 'N', 4)]);
        expect(out.N).toHaveLength(2);
    });

    it('drops arrivals with no usable direction', () => {
        const out = splitByDirection([a('1', '', 3), a('1', undefined, 4), a('1', 'N', 5)]);
        expect(out.N).toHaveLength(1);
        expect(out.S).toHaveLength(0);
    });

    it('handles empty and missing input', () => {
        expect(splitByDirection([])).toEqual({ N: [], S: [] });
        expect(splitByDirection(undefined)).toEqual({ N: [], S: [] });
    });

    it('does not mutate the input array order', () => {
        const input = [a('2', 'N', 9), a('1', 'N', 2)];
        splitByDirection(input);
        expect(input.map(x => x.minutes)).toEqual([9, 2]);
    });
});

describe('trunksInArrivals', () => {
    const TRUNKS = [
        { key: '123', routeIds: ['1', '2', '3'] },
        { key: 'NQRW', routeIds: ['N', 'Q', 'R', 'W'] },
        { key: '7', routeIds: ['7', '7X'] },
    ];

    it('keeps only trunks with trains running', () => {
        const out = trunksInArrivals([a('1', 'N', 3), a('R', 'S', 4)], TRUNKS);
        expect(out.map(t => t.key)).toEqual(['123', 'NQRW']);
    });

    it('preserves the canonical trunk order', () => {
        const out = trunksInArrivals([a('R', 'N', 3), a('1', 'N', 4)], TRUNKS);
        expect(out.map(t => t.key)).toEqual(['123', 'NQRW']);
    });

    it('matches an express variant to its parent trunk', () => {
        const out = trunksInArrivals([a('7X', 'N', 3)], TRUNKS);
        expect(out.map(t => t.key)).toEqual(['7']);
    });

    it('returns nothing when no trains are running', () => {
        expect(trunksInArrivals([], TRUNKS)).toEqual([]);
        expect(trunksInArrivals(undefined, TRUNKS)).toEqual([]);
    });
});

// The times on the station panel's Next stops rows (#161).
describe('soonestMinutes', () => {
    const board = [
        a('C', 'N', 9), a('A', 'N', 4), a('A', 'S', 2), a('F', 'N', 1), a('A', 'N', 12),
    ];

    it('gives the soonest train of the row\'s lines in one direction', () => {
        expect(soonestMinutes(board, ['A'], 'N')).toBe(4);
        expect(soonestMinutes(board, ['A'], 'S')).toBe(2);
        expect(soonestMinutes(board, ['A', 'C'], 'N')).toBe(4);
        expect(soonestMinutes(board, ['C'], 'N')).toBe(9);
    });

    it('gives null when none of the lines has a train that way', () => {
        expect(soonestMinutes(board, ['C'], 'S')).toBeNull();
        expect(soonestMinutes(board, ['R'], 'N')).toBeNull();
        expect(soonestMinutes([], ['A'], 'N')).toBeNull();
        expect(soonestMinutes(null, ['A'], 'N')).toBeNull();
    });

    it('counts an express pattern for its line', () => {
        expect(soonestMinutes([a('6X', 'S', 3), a('6', 'S', 7)], ['6'], 'S')).toBe(3);
    });

    it('skips a train whose last stop is this station', () => {
        const here = [a('A', 'S', 1, 'A41'), a('A', 'S', 6, 'A65')];
        expect(soonestMinutes(here, ['A'], 'S', ['A41', 'R29'])).toBe(6);
        expect(soonestMinutes(here, ['A'], 'S')).toBe(1);
    });

    it('keeps a train at the platform, which the feed can give as slightly negative', () => {
        expect(soonestMinutes([a('A', 'N', -1), a('A', 'N', 5)], ['A'], 'N')).toBe(-1);
        expect(soonestMinutes([a('A', 'N', undefined)], ['A'], 'N')).toBeNull();
    });
});

describe('minutesText', () => {
    it('says Now at or past the platform, and minutes otherwise', () => {
        expect(minutesText(0)).toBe('Now');
        expect(minutesText(-1)).toBe('Now');
        expect(minutesText(1)).toBe('1 min');
        expect(minutesText(12)).toBe('12 min');
    });
});
