// src/core/rt-parser.js
// Transforms decoded GTFS-RT FeedMessage objects into a flat arrival index.
// Pure data transformation — no fetching, no DOM, no side effects.
// All time values are Unix seconds from the protobuf feed; now is milliseconds (Date.now()).

// Strips the trailing N/S direction suffix from a GTFS stop ID to get the parent station ID.
// MTA uses directional IDs (127N, 127S) in real-time feeds; stops.txt uses parent IDs (127).
export function normalizeStopId(stopId) {
    return stopId.replace(/[NS]$/, '');
}

// Builds an arrival index from an array of decoded FeedMessage objects.
// Returns { [stopId]: [{routeId, direction, minutes, tripId}] } keyed on both
// the directional stop ID and the parent stop ID so lookups work either way.
// Filters out arrivals more than 60 seconds in the past or more than 60 minutes ahead.
// Each station's arrivals are sorted ascending by minutes.
export function buildArrivalIndex(feeds, now) {
    const index = {};
    const nowSeconds = now/1000;

    for (const feed of feeds) {
        if (!feed?.entity) continue;

        for (const entity of feed.entity) {
            const tripUpdate = entity.tripUpdate;
            if (!tripUpdate) continue;

            const routeId = tripUpdate.trip?.routeId ?? '';
            const tripId = tripUpdate.trip?.tripId ?? '';

            for (const stu of tripUpdate.stopTimeUpdate ?? []) {
                const stopId = stu.stopId;
                if (!stopId) continue;

                const raw = stu.arrival?.time ?? stu.departure?.time;
                if (raw == null) continue;

                const timeSeconds = Number(raw);
                const minutes = (timeSeconds - nowSeconds) / 60;

                if (minutes < -1 || minutes > 60) continue;

                const direction = stopId.endsWith('N') ? 'N' :
                                  stopId.endsWith('S') ? 'S' : '';
                
                const parentId = normalizeStopId(stopId);

                const arrival = { routeId, direction, minutes: Math.round(minutes), tripId };

                if (!index[stopId]) index[stopId] = [];
                index[stopId].push(arrival);

                if (parentId !== stopId) {
                    if (!index[parentId]) index[parentId] = [];
                    index[parentId].push(arrival);
                }
            }
        }
    }

    for (const key of Object.keys(index)) {
        index[key].sort((a, b) => a.minutes - b.minutes);
    }

    return index;
}

// VehicleStopStatus enum from the GTFS-RT spec. protobufjs decodes this field
// as a plain number on the message object — it only renders as a string name
// when passed through JSON.stringify — so callers must compare against these.
export const VEHICLE_STATUS = {
    INCOMING_AT: 0,
    STOPPED_AT: 1,
    IN_TRANSIT_TO: 2,
};

// Builds a flat list of live vehicle positions from decoded FeedMessage objects.
// MTA's subway feed publishes no GPS coordinates — only currentStatus + stopId
// relative to the route — so each vehicle carries its trip's full
// stopTimeUpdate sequence too, letting callers derive an approximate position
// along the route geometry (see scene/trains.js).
export function parseVehiclePositions(feeds) {
    const vehicles = [];

    for (const feed of feeds) {
        if (!feed?.entity) continue;

        const stopTimeUpdateByTripId = new Map();
        for (const entity of feed.entity) {
            const tripId = entity.tripUpdate?.trip?.tripId;
            if (tripId) stopTimeUpdateByTripId.set(tripId, entity.tripUpdate.stopTimeUpdate ?? []);
        }

        for (const entity of feed.entity) {
            const vehicle = entity.vehicle;
            if (!vehicle?.stopId || !vehicle.trip?.tripId) continue;

            vehicles.push({
                routeId: vehicle.trip.routeId ?? '',
                tripId: vehicle.trip.tripId,
                stopId: vehicle.stopId,
                currentStatus: vehicle.currentStatus ?? VEHICLE_STATUS.STOPPED_AT,
                stopTimeUpdate: stopTimeUpdateByTripId.get(vehicle.trip.tripId) ?? [],
            });
        }
    }

    return vehicles;
}
