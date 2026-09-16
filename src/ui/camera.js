// src/ui/camera.js
// Camera navigation via Maplibre's built-in pan and zoom.
//
// This module used to own a pitch curve: flat at overview zoom, tilting to 56
// degrees as you approached, on the reasoning that tilt is the only way to show
// one line running beneath another. That reasoning was sound and the payoff was
// not — the depth a tilted camera could have shown turned out to be illegible at
// every zoom, so the tilt was showing nothing. See "Why this is a 2D map" in the
// README. The camera is flat now, and there is no view toggle to release.

/**
 * Flies the map to center on a station at a closer zoom.
 */
export function flyToStation(map, station, zoom = 16) {
    map.flyTo({
        center: [station.lng, station.lat],
        zoom,
        duration: 1200,
    });
}
