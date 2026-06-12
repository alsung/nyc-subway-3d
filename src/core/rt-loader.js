// src/core/rt-loader.js
// Fetches and decodes all 8 MTA GTFS-RT protobuf feeds through the Go proxy.
// Uses Promise.allSettled so a single failing feed never blocks the rest.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

// Switch to 'http://localhost:8080' when running the Go proxy locally.
const PROXY = import.meta.env.PROD
    ? 'https://nyc-subway-proxy.fly.dev'
    : 'http://localhost:8080';

// One entry per MTA line group. All requests go through the proxy for CORS and caching.
const GTFS_RT_FEEDS = {
    '1234567S': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
    'ACE':      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
    'BDFM':     'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
    'G':        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
    'JZ':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
    'NQRW':     'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
    'L':        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
    'SIR':      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si',
};

// Fetches all 8 feeds in parallel, decodes each from protobuf binary, and returns
// { feeds, fetchedAt } where feeds is an array of decoded FeedMessage objects.
// Feeds that fail to fetch or decode are null — callers must handle sparse arrays.
// fetchedAt is a Date.now() timestamp used by the UI staleness indicator.
export async function loadRT() {
    const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
    const urls = Object.values(GTFS_RT_FEEDS);

    const results = await Promise.allSettled(
        urls.map(url => 
            fetch(`${PROXY}/proxy?url=${encodeURIComponent(url)}`)
                .then(r => r.ok ? r.arrayBuffer() : null)
        )
    );

    const feeds = results.map(result => {
        if (result.status === 'rejected' || result.value == null) return null;
        try {
            return FeedMessage.decode(new Uint8Array(result.value));
        } catch {
            return null;
        }
    });

    return { feeds, fetchedAt: Date.now() };
}
