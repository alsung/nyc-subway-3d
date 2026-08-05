// src/core/rt-parser.js
// Small shared helpers for interpreting GTFS-RT stop IDs and vehicle status.
// The heavy transforms (arrival index, vehicle positions) now run server-side in
// the Go API (Phase 5); the browser consumes clean JSON. See src/core/rt-loader.js.

// Strips the trailing N/S direction suffix from a GTFS stop ID to get the parent
// station ID. MTA uses directional IDs (127N, 127S) in real-time feeds; stops.txt
// uses parent IDs (127). Used by scene/trains.js to map a vehicle's stop onto the
// route curve.
export function normalizeStopId(stopId) {
    return stopId.replace(/[NS]$/, '');
}

// VehicleStopStatus enum from the GTFS-RT spec. The API returns currentStatus as
// a plain number; scene/trains.js compares against these to position vehicles.
export const VEHICLE_STATUS = {
    INCOMING_AT: 0,
    STOPPED_AT: 1,
    IN_TRANSIT_TO: 2,
};
