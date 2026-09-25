import { describe, it, expect } from 'vitest';
import { indexCarPositions, carAdvice, bestAdvice } from '../../src/core/car-position.js';

describe('indexCarPositions', () => {
    it('indexes by complex id', () => {
        const raw = [
            { c: '611', p: [{ ax: [1, 0], cx: [-73.98, 40.75], len: 180, e: [{ u: 0.2, t: 'stair' }] }] },
            { c: '602', p: [{ ax: [0, 1], cx: [-73.99, 40.73], len: 170, e: [] }] },
        ];
        const idx = indexCarPositions(raw);
        expect(idx.size).toBe(2);
        expect(idx.get('611')).toHaveLength(1);
        expect(idx.get('611')[0].len).toBe(180);
    });

    it('returns an empty map for bad input', () => {
        expect(indexCarPositions(null).size).toBe(0);
        expect(indexCarPositions('bad').size).toBe(0);
    });
});

// A synthetic two-stop line running south to north (lat increases).
// Platform axis points north (ay > 0), so dot product with the approach
// vector is positive → front at high u.
const STATIONS = new Map([
    ['A', { lat: 40.70, lng: -73.99 }],
    ['B', { lat: 40.75, lng: -73.99 }],
]);
const COMPLEX_MAP = new Map([['B', '100']]);

const mkLeg = (overrides = {}) => ({
    kind: 'ride',
    routeId: '1',
    fromStop: 'AN',
    toStop: 'BN',
    stops: ['AN', 'BN'],
    ...overrides,
});

const mkPositions = (entrances = [{ u: 0.8, t: 'stair' }], ax = [0, 1]) => {
    const idx = new Map();
    idx.set('100', [{
        ax,
        cx: [-73.99, 40.75],
        len: 180,
        e: entrances,
    }]);
    return idx;
};

const complexFor = (id) => COMPLEX_MAP.get(id);
const stationFor = (id) => STATIONS.get(id);

describe('carAdvice', () => {
    it('returns front for an exit near the high-u end when train approaches from the south', () => {
        const result = carAdvice(mkLeg(), complexFor, stationFor, mkPositions());
        expect(result).toHaveLength(1);
        expect(result[0].region).toBe('front');
    });

    it('returns back for an exit near the low-u end when train approaches from the south', () => {
        const result = carAdvice(mkLeg(), complexFor, stationFor, mkPositions([{ u: 0.1, t: 'stair' }]));
        expect(result[0].region).toBe('back');
    });

    it('flips when the train approaches from the north', () => {
        const leg = mkLeg({ fromStop: 'BN', toStop: 'AN', stops: ['BN', 'AN'] });
        const complexForA = (id) => id === 'A' ? '100' : undefined;
        const positions = new Map();
        positions.set('100', [{
            ax: [0, 1], cx: [-73.99, 40.70], len: 180,
            e: [{ u: 0.8, t: 'stair' }],
        }]);
        const result = carAdvice(leg, complexForA, stationFor, positions);
        expect(result[0].region).toBe('back');
    });

    it('returns null for walk legs', () => {
        expect(carAdvice(mkLeg({ kind: 'walk' }), complexFor, stationFor, mkPositions())).toBeNull();
    });

    it('returns null when the complex has no car position data', () => {
        expect(carAdvice(mkLeg(), complexFor, stationFor, new Map())).toBeNull();
    });

    it('returns null for a single-stop leg', () => {
        expect(carAdvice(mkLeg({ stops: ['AN'] }), complexFor, stationFor, mkPositions())).toBeNull();
    });

    it('handles the middle region', () => {
        const result = carAdvice(mkLeg(), complexFor, stationFor, mkPositions([{ u: 0.5, t: 'stair' }]));
        expect(result[0].region).toBe('middle');
    });

    it('works with an east-west platform axis', () => {
        const leg = mkLeg({
            fromStop: 'WN', toStop: 'EN', stops: ['WN', 'EN'],
        });
        const stations = new Map([
            ['W', { lat: 40.75, lng: -74.00 }],
            ['E', { lat: 40.75, lng: -73.98 }],
        ]);
        const complexForE = (id) => id === 'E' ? '200' : undefined;
        const positions = new Map();
        positions.set('200', [{
            ax: [1, 0], cx: [-73.98, 40.75], len: 180,
            e: [{ u: 0.9, t: 'elevator' }],
        }]);
        const result = carAdvice(leg, complexForE, (id) => stations.get(id), positions);
        expect(result[0].region).toBe('front');
        expect(result[0].type).toBe('elevator');
    });
});

describe('bestAdvice', () => {
    it('picks the region with the most exits', () => {
        const advice = [
            { u: 0.1, type: 'stair', region: 'back' },
            { u: 0.15, type: 'stair', region: 'back' },
            { u: 0.9, type: 'stair', region: 'front' },
        ];
        const best = bestAdvice(advice);
        expect(best.region).toBe('back');
        expect(best.count).toBe(2);
    });

    it('flags elevators', () => {
        const advice = [
            { u: 0.8, type: 'elevator', region: 'front' },
        ];
        expect(bestAdvice(advice).hasElevator).toBe(true);
    });

    it('returns null when all exits are in the middle', () => {
        const advice = [{ u: 0.5, type: 'stair', region: 'middle' }];
        expect(bestAdvice(advice)).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(bestAdvice([])).toBeNull();
        expect(bestAdvice(null)).toBeNull();
    });
});
