// src/ui/camera.js
// Camera navigation via Maplibre's built-in pan/zoom/pitch/bearing.
// Maplibre owns the camera now (see scene/renderer.js), so this module is
// just named presets and a fly-to helper — no OrbitControls, no manual tween.

const VIEW_3D = { pitch: 56, bearing: -17 };
const VIEW_2D = { pitch: 0, bearing: 0 };

// Flies the map to center on a station at a closer zoom, keeping the
// current pitch so the 2D/3D toggle state isn't disturbed by navigation.
export function flyToStation(map, station, zoom = 16) {
    map.flyTo({
        center: [station.lng, station.lat],
        zoom,
        pitch: map.getPitch(),
        duration: 1200,
    });
}

// Eases the map to the 2D top-down preset or the 3D tilted preset.
export function setView(map, mode) {
    const target = mode === '2d' ? VIEW_2D : VIEW_3D;
    map.easeTo({ ...target, duration: 800 });
}
