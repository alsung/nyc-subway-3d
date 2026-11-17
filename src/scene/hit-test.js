// src/scene/hit-test.js
// Which station a tap or a click means (#164).
//
// Station dots are drawn small at city zoom so they don't crowd the map (as
// small as 7 px across), which is far too small to hit with a finger. So the
// area that answers is larger than the dot: the station whose center is nearest
// the pointer, within half a target size of it.
//
// The target sizes are the published minimums:
// - touch: 44 px, Apple's default control size (44 x 44 pt) and WCAG 2.5.5 (AAA)
// - mouse: 24 px, WCAG 2.5.8 (AA)
// Targets that size can't all fit at city zoom, where stations sit 9 to 19 px
// apart. WCAG's own Essential exception names map pins for that reason, so
// overlapping targets are settled by distance, the way map apps pick a marker.
//
// DOM-free: the caller passes the map's projection.

/** Target size for a finger, in CSS px. */
export const TOUCH_TARGET_PX = 44;

/** Target size for a mouse or pen, in CSS px. */
export const POINTER_TARGET_PX = 24;

/**
 * The target size for the pointer that made an event. A pen is as precise as a
 * mouse. Without a pointer type (a browser that doesn't say), the device's
 * primary pointer decides.
 *
 * @param {string|undefined} pointerType from the DOM event: 'mouse', 'pen', 'touch' or ''
 * @param {boolean} coarse whether the primary pointer is coarse (a finger)
 */
export function targetSize(pointerType, coarse) {
    if (pointerType === 'touch') return TOUCH_TARGET_PX;
    if (pointerType === 'mouse' || pointerType === 'pen') return POINTER_TARGET_PX;
    return coarse ? TOUCH_TARGET_PX : POINTER_TARGET_PX;
}

/**
 * The feature whose point is nearest `point`, within `radius` px of it, or null.
 *
 * Features that `prefer` accepts win over nearer ones it doesn't, so a stop on a
 * selected line beats a closer dimmed station. The same station can arrive more
 * than once, from two layers that draw it; that is harmless here.
 *
 * @param {Array<{geometry: {coordinates: number[]}}>} features
 * @param {{x: number, y: number}} point in screen px
 * @param {(coordinates: number[]) => {x: number, y: number}} project to screen px
 * @param {number} radius in screen px
 * @param {(feature: object) => boolean} [prefer]
 */
export function nearestWithin(features, point, project, radius, prefer = null) {
    let best = null;
    let bestDistance = Infinity;
    let bestPreferred = false;

    for (const feature of features ?? []) {
        const at = project(feature.geometry.coordinates);
        const distance = Math.hypot(at.x - point.x, at.y - point.y);
        if (distance > radius) continue;

        const preferred = Boolean(prefer?.(feature));
        const better = preferred !== bestPreferred ? preferred : distance < bestDistance;
        if (better) {
            best = feature;
            bestDistance = distance;
            bestPreferred = preferred;
        }
    }
    return best;
}
