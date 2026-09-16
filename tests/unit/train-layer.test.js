import { describe, it, expect } from 'vitest';
import { buildRouteIndex, placeVehicles, trainFeatures } from '../../src/scene/train-layer.js';
import { VEHICLE_STATUS } from '../../src/core/rt-parser.js';

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos(40.73 * Math.PI / 180);

// lineRoutes is keyed [lat, lng], the order the GTFS parser emits.
const northLine = (meters, steps = 2) =>
    Array.from({ length: steps + 1 }, (_, i) => [(i / steps) * meters / M_PER_DEG_LAT, 0]);

const stationAt = (id, northMeters, eastMeters = 0) => ({
    id,
    lat: northMeters / M_PER_DEG_LAT,
    lng: eastMeters / M_PER_DEG_LNG,
});

describe('buildRouteIndex', () => {
    const line = northLine(4000, 4);

    it('places a station at its fraction along the line', () => {
        const index = buildRouteIndex({ A: [line] }, [stationAt('s1', 1000)]);
        expect(index.get('A')[0].stationU.get('s1')).toBeCloseTo(0.25, 4);
    });

    it('matches within the radius and not beyond it', () => {
        const stations = [
            stationAt('near', 1000, 140),
            stationAt('far', 1000, 160),
        ];
        const { stationU } = buildRouteIndex({ A: [line] }, stations).get('A')[0];

        expect(stationU.has('near')).toBe(true);
        expect(stationU.has('far')).toBe(false);
    });

    it('indexes each branch separately', () => {
        // Two branches sharing their first kilometer, then diverging: one runs
        // on north, the other turns east.
        const shared = [[0, 0], [1000 / M_PER_DEG_LAT, 0]];
        const northBranch = [...shared, [3000 / M_PER_DEG_LAT, 0]];
        const eastBranch = [...shared, [1000 / M_PER_DEG_LAT, 2000 / M_PER_DEG_LNG]];

        const index = buildRouteIndex({ A: [northBranch, eastBranch] }, [
            stationAt('junction', 1000),
            stationAt('onNorth', 3000),
            stationAt('onEast', 1000, 2000),
        ]);
        const [north, east] = index.get('A');

        // The shared stop is on both; the divergent ones are on one each. That
        // distinction is the whole reason the index is per branch — it is what
        // puts a Rockaway-bound A on a different line from a Lefferts-bound one.
        expect(north.stationU.has('junction')).toBe(true);
        expect(east.stationU.has('junction')).toBe(true);
        expect(north.stationU.has('onNorth')).toBe(true);
        expect(north.stationU.has('onEast')).toBe(false);
        expect(east.stationU.has('onEast')).toBe(true);
        expect(east.stationU.has('onNorth')).toBe(false);
    });

    it('skips degenerate geometry rather than indexing it', () => {
        const index = buildRouteIndex({ A: [[[0, 0]]], B: [northLine(1000)] }, [stationAt('s1', 500)]);
        expect(index.has('A')).toBe(false);
        expect(index.has('B')).toBe(true);
    });
});

describe('placeVehicles', () => {
    const routeIndex = buildRouteIndex({ A: [northLine(4000, 4)] }, [
        stationAt('s1', 1000),
        stationAt('s2', 2000),
    ]);

    const vehicle = (tripId, stopId, next) => ({
        routeId: 'A',
        tripId,
        stopId,
        currentStatus: VEHICLE_STATUS.STOPPED_AT,
        stopTimeUpdate: [{ stopId }, { stopId: next }],
    });

    it('drops vehicles no line can carry', () => {
        const placed = placeVehicles([
            vehicle('t1', 's1', 's2'),
            { ...vehicle('t2', 's1', 's2'), routeId: 'ZZ' },   // route has no geometry
            vehicle('t3', 'nope', 's2'),                        // stop on no line
        ], routeIndex);

        expect(placed.map(p => p.tripId)).toEqual(['t1']);
    });

    it('keeps a trip\'s sort key stable across snapshots', () => {
        const keys = new Map();
        const first = placeVehicles([vehicle('t1', 's1', 's2'), vehicle('t2', 's2', 's1')], routeIndex, keys);
        // Same trips, reversed order in the feed.
        const second = placeVehicles([vehicle('t2', 's2', 's1'), vehicle('t1', 's1', 's2')], routeIndex, keys);

        const keyOf = (placed, tripId) => placed.find(p => p.tripId === tripId).sortKey;
        expect(keyOf(second, 't1')).toBe(keyOf(first, 't1'));
        expect(keyOf(second, 't2')).toBe(keyOf(first, 't2'));
        // Stability is what keeps collision from reshuffling which bullets
        // survive every time a snapshot lands.
        expect(keyOf(first, 't1')).not.toBe(keyOf(first, 't2'));
    });

    it('forgets trips that have stopped running', () => {
        const keys = new Map();
        placeVehicles([vehicle('t1', 's1', 's2'), vehicle('t2', 's2', 's1')], routeIndex, keys);
        placeVehicles([vehicle('t1', 's1', 's2')], routeIndex, keys);

        // Otherwise the map grows for the life of the session.
        expect([...keys.keys()]).toEqual(['t1']);
    });
});

describe('trainFeatures', () => {
    const routeIndex = buildRouteIndex({ A: [northLine(4000, 4)] }, [stationAt('s1', 1000)]);

    it('emits one point per train, carrying its bullet', () => {
        const placed = placeVehicles([{
            routeId: 'A',
            tripId: 't1',
            stopId: 's1',
            currentStatus: VEHICLE_STATUS.STOPPED_AT,
            stopTimeUpdate: [{ stopId: 's1' }],
        }], routeIndex);

        const { type, features } = trainFeatures(placed);
        expect(type).toBe('FeatureCollection');
        expect(features).toHaveLength(1);
        expect(features[0].properties.icon).toBe('train-A');
        expect(features[0].geometry.coordinates[1] * M_PER_DEG_LAT).toBeCloseTo(1000, 0);
    });

    it('is an empty collection when nothing is running', () => {
        expect(trainFeatures([]).features).toEqual([]);
    });
});
