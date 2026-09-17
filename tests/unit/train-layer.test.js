import { describe, it, expect } from 'vitest';
import { buildRouteIndex, placeVehicles, trainFeatures, advanceTrains } from '../../src/scene/train-layer.js';
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

describe('advanceTrains', () => {
    const M_LAT = 111_320;
    const line = Array.from({ length: 5 }, (_, i) => [(i * 1000) / M_LAT, 0]);
    const routeIndex = buildRouteIndex({ A: [line] }, [
        { id: 's1', lat: 0, lng: 0 },
        { id: 's2', lat: 2000 / M_LAT, lng: 0 },
    ]);
    const T = 1_700_000_000;

    // s1 is at u = 0, s2 at u = 0.5 along a 4 km line.
    const vehicle = (window) => ({
        routeId: 'A',
        tripId: 't1',
        stopId: 's1',
        currentStatus: VEHICLE_STATUS.STOPPED_AT,
        stopTimeUpdate: window,
    });

    it('moves a train between two stops by wall clock', () => {
        const placed = placeVehicles([vehicle([
            { stopId: 's1', arrival: T, departure: T },
            { stopId: 's2', arrival: T + 100, departure: T + 100 },
        ])], routeIndex);

        advanceTrains(placed, (T + 50) * 1000);
        // Halfway in time is halfway in distance: u = 0.25 of the whole line.
        expect(placed[0].u).toBeCloseTo(0.25, 4);

        advanceTrains(placed, (T + 80) * 1000);
        expect(placed[0].u).toBeCloseTo(0.40, 4);
    });

    it('extrapolates backward for a train short of its own stop', () => {
        const placed = placeVehicles([vehicle([
            { stopId: 's1', arrival: T + 50, departure: T + 50 },
            { stopId: 's2', arrival: T + 150, departure: T + 150 },
        ])], routeIndex);

        advanceTrains(placed, T * 1000);
        // Half a hop short of s1, which sits at u = 0, so it clamps to the
        // start of the line rather than running off it.
        expect(placed[0].u).toBe(0);
    });

    it('holds the snapshot position when the times cannot place it', () => {
        // Arrival far in the future: a run that has not started. These are about
        // a quarter of the feed and must not be moved or hidden.
        const placed = placeVehicles([vehicle([
            { stopId: 's1', arrival: T + 4000, departure: T + 4000 },
            { stopId: 's2', arrival: T + 4100, departure: T + 4100 },
        ])], routeIndex);
        const before = placed[0].u;

        const moved = advanceTrains(placed, T * 1000);
        expect(moved).toBe(0);
        expect(placed[0].u).toBe(before);
    });

    it('holds when the window names a stop this line does not carry', () => {
        const placed = placeVehicles([vehicle([
            { stopId: 's1', arrival: T, departure: T },
            { stopId: 'elsewhere', arrival: T + 100, departure: T + 100 },
        ])], routeIndex);
        const before = placed[0].u;

        expect(advanceTrains(placed, (T + 50) * 1000)).toBe(0);
        expect(placed[0].u).toBe(before);
    });

    it('counts only the trains the times actually placed', () => {
        const placeable = placeVehicles([vehicle([
            { stopId: 's1', arrival: T, departure: T },
            { stopId: 's2', arrival: T + 100, departure: T + 100 },
        ])], routeIndex);
        expect(advanceTrains(placeable, (T + 50) * 1000)).toBe(1);
    });
});

describe('advanceTrains speed guard', () => {
    const M_LAT = 111_320;
    // A 20 km line, so consecutive stops are far apart in meters.
    const line = Array.from({ length: 3 }, (_, i) => [(i * 10_000) / M_LAT, 0]);
    const routeIndex = buildRouteIndex({ A: [line] }, [
        { id: 's1', lat: 0, lng: 0 },
        { id: 's2', lat: 10_000 / M_LAT, lng: 0 },
    ]);
    const T = 1_700_000_000;

    const run = (hopSeconds) => {
        const placed = placeVehicles([{
            routeId: 'A', tripId: 't1', stopId: 's1',
            currentStatus: VEHICLE_STATUS.STOPPED_AT,
            stopTimeUpdate: [
                { stopId: 's1', arrival: T, departure: T },
                { stopId: 's2', arrival: T + hopSeconds, departure: T + hopSeconds },
            ],
        }], routeIndex);
        const moved = advanceTrains(placed, (T + hopSeconds / 2) * 1000);
        return { u: placed[0].u, moved };
    };

    it('animates a hop at a plausible speed', () => {
        // 10 km in 600s is 16.7 m/s, a fast express but a real one.
        const { u, moved } = run(600);
        expect(moved).toBe(1);
        expect(u).toBeCloseTo(0.25, 3);
    });

    it('holds at the stop it left when the feed implies an impossible speed', () => {
        // 10 km in 100s is 100 m/s. Seen for real: the E published consecutive
        // stops one second apart, and a D hop covered 3.81 km in 73s.
        const { u, moved } = run(100);
        expect(moved).toBe(0);
        expect(u).toBe(0);
    });
});
