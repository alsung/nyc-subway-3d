// src/scene/platform-layer.js
// Platform footprints for the station currently open.
//
// A Maplibre fill layer rather than Three.js geometry, because these are drawn
// flat. That was not the original plan: they were first built as extruded slabs
// at their OSM level, so a station would read as platforms stacked at depth.
// Measured on screen, that does not work at either end.
//
// At true scale the whole vertical range of a station is about 15px at zoom
// 16.4 — the map is 1.37 m/px there — and the tubes, 12 m wide at z=0, sit
// directly over it. Exaggerating the depth makes it visible but wrong: under a
// 60 degree pitch, vertical offset projects down the screen, so at 30 m per
// level the slabs land 76px from the station they belong to and read as debris
// scattered across the map. There is no constant that is both visible and
// truthful.
//
// Flat, they work: Times Sq becomes eight long platforms along Broadway with
// the shuttle crossing them, which is a real upgrade on a single dot. And once
// flat, a fill layer is simply the right tool — it composes with the basemap and
// the station circles instead of competing with them for depth.

const PLATFORM_COLOR = '#7d8592';
const PLATFORM_OPACITY = 0.55;
const PLATFORM_OUTLINE = '#aab1bd';

// Below this a station is still a single dot, and drawing a 150 m platform
// under a 10px circle claims a precision the view does not have.
const PLATFORM_MINZOOM = 15;

const EMPTY = { type: 'FeatureCollection', features: [] };

/** Adds the platform source and layers, initially empty. */
export function addPlatformLayer(map) {
    if (!map || map.getSource('station-platforms')) return;

    map.addSource('station-platforms', { type: 'geojson', data: EMPTY });

    map.addLayer({
        id: 'platform-fill',
        type: 'fill',
        source: 'station-platforms',
        minzoom: PLATFORM_MINZOOM,
        paint: {
            'fill-color': PLATFORM_COLOR,
            'fill-opacity': PLATFORM_OPACITY,
        },
        // Beneath the entrance dots and station circles: the footprint is
        // context for them, not a replacement.
    }, 'entrance-dots');

    map.addLayer({
        id: 'platform-outline',
        type: 'line',
        source: 'station-platforms',
        minzoom: PLATFORM_MINZOOM,
        paint: {
            'line-color': PLATFORM_OUTLINE,
            'line-width': 1,
            'line-opacity': 0.7,
        },
    }, 'entrance-dots');
}

/**
 * Shows the given platforms and hides everything else. Pass null or [] to clear.
 *
 * @param {object} map
 * @param {{level: number|null, ring: [number, number][]}[]} platforms
 */
export function setPlatformsFor(map, platforms) {
    const source = map?.getSource?.('station-platforms');
    if (!source) return;

    const features = (platforms ?? [])
        .filter(p => Array.isArray(p?.ring) && p.ring.length >= 3)
        .map(p => ({
            type: 'Feature',
            properties: { level: p.level ?? null },
            geometry: {
                type: 'Polygon',
                // platforms.json stores [lat, lng]; GeoJSON wants [lng, lat],
                // and a ring has to close on itself.
                coordinates: [closeRing(p.ring.map(([lat, lng]) => [lng, lat]))],
            },
        }));

    source.setData({ type: 'FeatureCollection', features });
}

function closeRing(coords) {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) return coords;
    return [...coords, first];
}
