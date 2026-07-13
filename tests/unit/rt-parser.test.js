import { describe, it, expect } from 'vitest';
import { normalizeStopId, buildArrivalIndex, parseVehiclePositions, VEHICLE_STATUS } from '../../src/core/rt-parser.js';

// Fixed reference time — all arrival times are expressed relative to this.
const NOW_MS = 1_000_000_000_000;
const NOW_S  = NOW_MS / 1000;

function makeFeed(entities) {
    return { entity: entities };
}

function makeEntity(routeId, tripId, stopTimeUpdates) {
    return {
        tripUpdate: {
            trip: { routeId, tripId },
            stopTimeUpdate: stopTimeUpdates,
        },
    };
}

function makeStu(stopId, arrivalSeconds) {
    return { stopId, arrival: { time: arrivalSeconds } };
}

function makeVehicleEntity(routeId, tripId, stopId, currentStatus) {
    return {
        vehicle: {
            trip: { routeId, tripId },
            stopId,
            currentStatus,
        },
    };
}

// ── normalizeStopId ───────────────────────────────────────────────────────────

describe('normalizeStopId', () => {
    it('strips N suffix', () => {
        expect(normalizeStopId('127N')).toBe('127');
    });

    it('strips S suffix', () => {
        expect(normalizeStopId('127S')).toBe('127');
    });

    it('leaves non-directional IDs unchanged', () => {
        expect(normalizeStopId('A27')).toBe('A27');
    });

    it('leaves IDs ending in letters other than N or S unchanged', () => {
        expect(normalizeStopId('G22')).toBe('G22');
    });

    it('handles empty string', () => {
        expect(normalizeStopId('')).toBe('');
    });
});

// ── buildArrivalIndex ─────────────────────────────────────────────────────────

describe('buildArrivalIndex', () => {
    it('indexes arrival by directional stop ID', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [makeStu('127N', NOW_S + 300)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127N']).toBeDefined();
    });

    it('indexes arrival by parent stop ID', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [makeStu('127N', NOW_S + 300)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127']).toBeDefined();
    });

    it('directional and parent entries contain the same routeId', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [makeStu('127N', NOW_S + 300)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127N'][0].routeId).toBe('4');
        expect(index['127'][0].routeId).toBe('4');
    });

    it('filters out arrivals more than 60 seconds in the past', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [makeStu('127N', NOW_S - 120)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127N']).toBeUndefined();
    });

    it('allows arrivals up to 60 seconds in the past', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [makeStu('127N', NOW_S - 30)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127N']).toBeDefined();
    });

    it('filters out arrivals more than 60 minutes in the future', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [makeStu('127N', NOW_S + 4000)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127N']).toBeUndefined();
    });

    it('sorts arrivals ascending by minutes', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [
            makeStu('127N', NOW_S + 600),
            makeStu('127N', NOW_S + 120),
            makeStu('127N', NOW_S + 300),
        ])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        const mins = index['127N'].map(a => a.minutes);
        expect(mins).toEqual([...mins].sort((a, b) => a - b));
    });

    it('merges arrivals from multiple feeds', () => {
        const feed1 = makeFeed([makeEntity('4', 'trip1', [makeStu('631N', NOW_S + 120)])]);
        const feed2 = makeFeed([makeEntity('6', 'trip2', [makeStu('631N', NOW_S + 240)])]);
        const index = buildArrivalIndex([feed1, feed2], NOW_MS);
        expect(index['631N'].length).toBe(2);
    });

    it('skips null and undefined feed entries without throwing', () => {
        expect(() => buildArrivalIndex([null, undefined], NOW_MS)).not.toThrow();
    });

    it('skips entities without tripUpdate', () => {
        const feed = makeFeed([{ vehicle: { trip: { routeId: '4' } } }]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(Object.keys(index).length).toBe(0);
    });

    it('skips stop time updates missing both arrival and departure time', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [{ stopId: '127N' }])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127N']).toBeUndefined();
    });

    it('sets direction N for northbound stop IDs', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [makeStu('127N', NOW_S + 300)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127N'][0].direction).toBe('N');
    });

    it('sets direction S for southbound stop IDs', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [makeStu('127S', NOW_S + 300)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127S'][0].direction).toBe('S');
    });

    it('sets empty direction for non-directional stop IDs', () => {
        const feed = makeFeed([makeEntity('G', 'trip1', [makeStu('G22', NOW_S + 300)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['G22'][0].direction).toBe('');
    });

    it('does not create a duplicate parent entry when stop ID has no direction suffix', () => {
        const feed = makeFeed([makeEntity('G', 'trip1', [makeStu('G22', NOW_S + 300)])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['G22'].length).toBe(1);
    });

    it('coerces Long-like objects to number via Number()', () => {
        const longLike = { valueOf: () => NOW_S + 300 };
        const feed = makeFeed([makeEntity('4', 'trip1', [
            { stopId: '127N', arrival: { time: longLike } },
        ])]);
        const index = buildArrivalIndex([feed], NOW_MS);
        expect(index['127N']).toBeDefined();
    });
});

// ── VEHICLE_STATUS ────────────────────────────────────────────────────────────

describe('VEHICLE_STATUS', () => {
    it('matches the GTFS-RT VehicleStopStatus enum ordering', () => {
        expect(VEHICLE_STATUS.INCOMING_AT).toBe(0);
        expect(VEHICLE_STATUS.STOPPED_AT).toBe(1);
        expect(VEHICLE_STATUS.IN_TRANSIT_TO).toBe(2);
    });
});

// ── parseVehiclePositions ─────────────────────────────────────────────────────

describe('parseVehiclePositions', () => {
    it('extracts routeId, tripId, stopId, and currentStatus from a vehicle entity', () => {
        const feed = makeFeed([makeVehicleEntity('4', 'trip1', '127N', VEHICLE_STATUS.STOPPED_AT)]);
        const vehicles = parseVehiclePositions([feed]);
        expect(vehicles).toEqual([{
            routeId: '4',
            tripId: 'trip1',
            stopId: '127N',
            currentStatus: VEHICLE_STATUS.STOPPED_AT,
            stopTimeUpdate: [],
        }]);
    });

    it('attaches the matching tripUpdate stopTimeUpdate array by tripId', () => {
        const stus = [makeStu('127N', NOW_S + 60), makeStu('631N', NOW_S + 180)];
        const feed = makeFeed([
            makeEntity('4', 'trip1', stus),
            makeVehicleEntity('4', 'trip1', '127N', VEHICLE_STATUS.IN_TRANSIT_TO),
        ]);
        const [vehicle] = parseVehiclePositions([feed]);
        expect(vehicle.stopTimeUpdate).toBe(stus);
    });

    it('defaults stopTimeUpdate to an empty array when no matching tripUpdate exists', () => {
        const feed = makeFeed([makeVehicleEntity('4', 'trip1', '127N', VEHICLE_STATUS.STOPPED_AT)]);
        const [vehicle] = parseVehiclePositions([feed]);
        expect(vehicle.stopTimeUpdate).toEqual([]);
    });

    it('skips vehicle entities missing stopId', () => {
        const feed = makeFeed([{ vehicle: { trip: { routeId: '4', tripId: 'trip1' } } }]);
        expect(parseVehiclePositions([feed])).toEqual([]);
    });

    it('skips vehicle entities missing trip', () => {
        const feed = makeFeed([{ vehicle: { stopId: '127N' } }]);
        expect(parseVehiclePositions([feed])).toEqual([]);
    });

    it('skips entities without a vehicle field', () => {
        const feed = makeFeed([makeEntity('4', 'trip1', [makeStu('127N', NOW_S + 60)])]);
        expect(parseVehiclePositions([feed])).toEqual([]);
    });

    it('merges vehicles from multiple feeds', () => {
        const feed1 = makeFeed([makeVehicleEntity('4', 'trip1', '127N', VEHICLE_STATUS.STOPPED_AT)]);
        const feed2 = makeFeed([makeVehicleEntity('6', 'trip2', '631N', VEHICLE_STATUS.IN_TRANSIT_TO)]);
        expect(parseVehiclePositions([feed1, feed2]).length).toBe(2);
    });

    it('skips null and undefined feed entries without throwing', () => {
        expect(() => parseVehiclePositions([null, undefined])).not.toThrow();
    });

    it('defaults currentStatus to STOPPED_AT when missing', () => {
        const feed = makeFeed([{ vehicle: { trip: { routeId: '4', tripId: 'trip1' }, stopId: '127N' } }]);
        const [vehicle] = parseVehiclePositions([feed]);
        expect(vehicle.currentStatus).toBe(VEHICLE_STATUS.STOPPED_AT);
    });
});
