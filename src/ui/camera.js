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

// One-shot opening animation. The map is created flat so the initial tile set
// stays small (see renderer.js); this tilts it into the 3D view once loading is
// done. It sets pitch and bearing only — no center — so it never pulls the map
// away from wherever the user has navigated. If a flyTo is still in flight it
// waits for that to land first, rather than cutting the animation short.
// Users who ask for reduced motion get the same end state without the tween.
export function introToThreeD(map) {
    if (map.isMoving()) {
        map.once('moveend', () => introToThreeD(map));
        return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        map.setPitch(VIEW_3D.pitch);
        map.setBearing(VIEW_3D.bearing);
        return;
    }
    map.easeTo({ ...VIEW_3D, duration: 1500 });
}
