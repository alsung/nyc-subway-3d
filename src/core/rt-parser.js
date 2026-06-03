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
