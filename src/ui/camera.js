// src/ui/camera.js
// Camera navigation via Maplibre's built-in pan/zoom/pitch/bearing.
// Maplibre owns the camera now (see scene/renderer.js), so this module is
// just named presets and a fly-to helper — no OrbitControls, no manual tween.

const VIEW_3D = { pitch: 56, bearing: -17 };
const VIEW_2D = { pitch: 0, bearing: 0 };

// Where the camera starts and finishes tilting, in zoom levels.
//
// Tilt at overview zoom costs legibility and buys nothing: it pushes the far
// side of the city into the horizon and compresses the network into the middle
// of the screen. Tilt on approach is the opposite — it is the only way to see
// that one line runs beneath another. So pitch follows zoom rather than a
// button, and the 3D becomes what happens when you lean in.
const PITCH_FLAT_BELOW = 13;
const PITCH_FULL_ABOVE = 15.5;

/**
 * The pitch the camera should hold at a given zoom.
 *
 * Eased rather than linear so the tilt arrives gradually and settles, instead of
 * ramping at a constant rate and stopping dead at the top of the range.
 */
export function pitchForZoom(zoom) {
    const z = Number.isFinite(zoom) ? zoom : 0;
    if (z <= PITCH_FLAT_BELOW) return VIEW_2D.pitch;
    if (z >= PITCH_FULL_ABOVE) return VIEW_3D.pitch;

    const t = (z - PITCH_FLAT_BELOW) / (PITCH_FULL_ABOVE - PITCH_FLAT_BELOW);
    const eased = t * t * (3 - 2 * t);          // smoothstep
    return VIEW_3D.pitch * eased;
}

// Flies the map to center on a station at a closer zoom.
//
// Pitch is deliberately not passed. flyTo animates zoom, which fires the zoom
// handler below, so the camera tilts on the way in as part of the same motion.
// Pinning the current pitch here would fight that — and when the reader has set
// an override, the handler leaves it alone anyway.
export function flyToStation(map, station, zoom = 16) {
    map.flyTo({
        center: [station.lng, station.lat],
        zoom,
        // The destination pitch travels with the flight rather than being
        // applied to it. Setting pitch while a flyTo is in the air counts as a
        // new camera command and cancels it — which stranded this one at zoom
        // 13.5 instead of 16, with the tilt to match.
        ...(override === null ? { pitch: pitchForZoom(zoom) } : {}),
        duration: 1200,
    });
}

// A user's explicit choice, which outranks the zoom-driven pitch until they
// release it. Automatic behavior with no way out is worse than a button: a
// reader who wants Brooklyn flat at close zoom should be able to have it.
let override = null;   // '2d' | '3d' | null

/**
 * Applies a pitch override, or clears it when the same mode is pressed again.
 * Returns the mode now in force, or null when the camera is back on automatic.
 */
export function toggleView(map, mode) {
    override = override === mode ? null : mode;

    if (override === null) {
        // Back to automatic: settle to whatever this zoom asks for.
        map.easeTo({ pitch: pitchForZoom(map.getZoom()), duration: 600 });
        return null;
    }
    const target = override === '2d' ? VIEW_2D : VIEW_3D;
    map.easeTo({ ...target, duration: 800 });
    return override;
}

/** The active override, for the buttons' pressed state. */
export function currentOverride() {
    return override;
}

/**
 * Drives pitch from zoom for the life of the map.
 *
 * Bound to 'zoom' rather than 'zoomend' so the tilt tracks the gesture instead
 * of snapping when it finishes. setPitch, not easeTo, for the same reason —
 * starting an animation on every zoom frame would fight the user's input.
 */
export function attachAutoPitch(map) {
    map.on('zoom', (e) => {
        if (override !== null) return;

        // Only respond to zooms the reader performed. A programmatic camera
        // move — flyTo, easeTo — carries no originating DOM event, and calling
        // setPitch during one cancels the animation partway. Those moves pass
        // their own destination pitch instead, so the tilt travels with the
        // flight rather than fighting it.
        if (!e?.originalEvent) return;

        const want = pitchForZoom(map.getZoom());
        // Maplibre reports pitch as a float; skipping sub-degree corrections
        // avoids a write on every frame of a gesture that barely changes zoom.
        if (Math.abs(map.getPitch() - want) > 0.5) map.setPitch(want);
    });
}
