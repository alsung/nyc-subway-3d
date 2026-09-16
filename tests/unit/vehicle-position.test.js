import { describe, it, expect } from 'vitest';
import { deriveVehicleT } from '../../src/scene/trains.js';
import { VEHICLE_STATUS } from '../../src/core/rt-parser.js';

// deriveVehicleT reads "the next stop" as the first entry in stopTimeUpdate whose
// id differs from the vehicle's own. That is only the stop ahead if the sequence
// starts at the vehicle. MTA's feed does not guarantee it: measured against a
// live snapshot, 13 of 239 vehicles carried a sequence that still listed stops
// they had already left, and for those the scan resolved a stop *behind* the
// train as its next one.
//
// The API now anchors the window it sends on the vehicle's own stop
// (trimStops in api/vehicles.go), which makes the first differing entry the stop
// ahead. These tests pin what that anchoring buys, in both places the derived
// "next stop" is used: direction of travel, and branch selection.
//
// Note the coupling this documents — deriveVehicleT is correct here only because
// the API trims. Worth removing rather than preserving when this file is
// rewritten for the flat train layer.

// t-parameters for one branch, keyed the way buildStationTByRoute keys them.
const branch = (entries) => new Map(Object.entries(entries));

// The sequence as the feed publishes it, passed stops and all.
const rawSequence = ['S14', 'S15', 'S16', 'S17', 'S18', 'S19']
    .map(id => ({ stopId: `${id}N` }));

// The same sequence after the API anchors it on the vehicle's stop.
const anchored = (stops, stopId, max = 4) => {
    const start = Math.max(0, stops.findIndex(s => s.stopId === stopId));
    return stops.slice(start, start + max);
};

describe('deriveVehicleT direction of travel', () => {
    // Stops run in increasing t along the curve, so "ahead" is a larger t.
    const stationTs = [branch({
        S14: 0.10, S15: 0.20, S16: 0.30, S17: 0.40, S18: 0.50, S19: 0.60,
    })];

    const vehicle = (stopTimeUpdate) => ({
        stopId: 'S16N',
        currentStatus: VEHICLE_STATUS.IN_TRANSIT_TO,
        stopTimeUpdate,
    });

    it('places an approaching train behind the stop it is heading to', () => {
        const { t } = deriveVehicleT(vehicle(anchored(rawSequence, 'S16N')), stationTs);

        // IN_TRANSIT_TO means the train has not reached S16 yet, so it belongs
        // between S15 and S16 — short of t = 0.30, never past it.
        expect(t).toBeLessThan(0.30);
        expect(t).toBeGreaterThan(0.20);
    });

    it('is placed past its target when the sequence still lists passed stops', () => {
        // The pre-anchoring behavior, kept as a test so the reason the API trims
        // is visible from the frontend rather than only from the API's comments.
        const { t } = deriveVehicleT(vehicle(rawSequence), stationTs);

        // The scan lands on S14, two stops behind, so the direction inverts and
        // the train is pushed forward past the station it has not reached.
        expect(t).toBeGreaterThan(0.30);
    });

    it('agrees with the anchored window when the feed lists no passed stops', () => {
        const clean = rawSequence.slice(2); // S16 onward
        const fromRaw = deriveVehicleT(vehicle(clean), stationTs);
        const fromWindow = deriveVehicleT(vehicle(anchored(clean, 'S16N')), stationTs);

        expect(fromWindow.t).toBeCloseTo(fromRaw.t, 10);
    });
});

describe('deriveVehicleT branch selection', () => {
    // Branch selection runs for every vehicle including stopped ones, so a
    // passed stop can put a train on the wrong branch even when its position
    // along that branch is exact.
    const stationTs = [
        // The branch the train came from: carries the passed stop, not the next.
        branch({ S14: 0.10, S15: 0.20, S16: 0.30 }),
        // The branch it is actually running: carries the stop ahead.
        branch({ S16: 0.30, S17: 0.40, S18: 0.50 }),
    ];

    const vehicle = (stopTimeUpdate) => ({
        stopId: 'S16N',
        currentStatus: VEHICLE_STATUS.STOPPED_AT,
        stopTimeUpdate,
    });

    it('chooses the branch carrying the stop ahead', () => {
        const { curveIndex } = deriveVehicleT(vehicle(anchored(rawSequence, 'S16N')), stationTs);
        expect(curveIndex).toBe(1);
    });

    it('chooses the branch behind it when the sequence lists passed stops', () => {
        const { curveIndex } = deriveVehicleT(vehicle(rawSequence), stationTs);
        expect(curveIndex).toBe(0);
    });
});

describe('deriveVehicleT degraded inputs', () => {
    const stationTs = [branch({ S16: 0.30, S17: 0.40 })];

    it('snaps to the stop when the window holds nothing else', () => {
        // The vehicle's stop is the last of its trip, so the window is one entry
        // and there is no direction to derive. Unchanged by the trim.
        const { t } = deriveVehicleT({
            stopId: 'S16N',
            currentStatus: VEHICLE_STATUS.IN_TRANSIT_TO,
            stopTimeUpdate: [{ stopId: 'S16N' }],
        }, stationTs);

        expect(t).toBe(0.30);
    });

    it('returns null when the target stop is on no branch', () => {
        expect(deriveVehicleT({
            stopId: 'X99N',
            currentStatus: VEHICLE_STATUS.STOPPED_AT,
            stopTimeUpdate: [{ stopId: 'X99N' }, { stopId: 'S17N' }],
        }, stationTs)).toBeNull();
    });
});
