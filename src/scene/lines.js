// src/scene/lines.js
// Highlighting and filtering for the route layer.
//
// Every route used to be drawn twice — a Maplibre line below the swap zoom and a
// Three.js tube above it — and this module had to reach both. It reliably did
// not. Two bugs shipped from exactly that: highlightLine dimmed only the meshes,
// so an itinerary framed at city zoom produced no visible change at all, and
// setLineVisibility hid only the meshes, so a filtered-out route stayed on
// screen at overview zoom. Both were invisible to whoever wrote them, because
// the half they touched looked right at the zoom they were testing at.
//
// There is one representation now, so that class of bug is gone rather than
// guarded against.

// How far a route recedes when something else is highlighted. Faint enough to
// read as background, present enough that the network's shape survives.
const DIMMED_OPACITY = 0.12;
const NORMAL_OPACITY = 0.95;

/**
 * Dims every route except the given ones.
 *
 * @param {object} map Maplibre map
 * @param {string|string[]} routeIds
 */
export function highlightLine(map, routeIds) {
    if (!map?.getLayer?.('route-lines')) return;
    const wanted = [...new Set(Array.isArray(routeIds) ? routeIds : [routeIds])];

    // Every feature carries routeId, from the corridor work — so the layer can
    // be dimmed by expression without touching its geometry.
    map.setPaintProperty('route-lines', 'line-opacity', [
        'case',
        ['in', ['get', 'routeId'], ['literal', wanted]], NORMAL_OPACITY,
        DIMMED_OPACITY,
    ]);
}

export function clearLineHighlight(map) {
    if (!map?.getLayer?.('route-lines')) return;
    map.setPaintProperty('route-lines', 'line-opacity', NORMAL_OPACITY);
}

// Maplibre has no per-feature visibility, so the layer is filtered by the set of
// hidden route ids instead.
const hiddenRoutes = new Set();

/**
 * Shows or hides one route.
 *
 * @returns {Set<string>} the routes now hidden, so callers can filter trains to
 *   match without keeping a second copy of this state.
 */
export function setLineVisibility(map, routeId, visible) {
    if (visible) hiddenRoutes.delete(routeId);
    else hiddenRoutes.add(routeId);

    if (map?.getLayer?.('route-lines')) {
        map.setFilter('route-lines',
            hiddenRoutes.size === 0
                ? null
                : ['!', ['in', ['get', 'routeId'], ['literal', [...hiddenRoutes]]]]);
    }

    return hiddenRoutes;
}

/** Test seam: the filter is module state, and a test must be able to reset it. */
export function resetLineVisibility() {
    hiddenRoutes.clear();
}
