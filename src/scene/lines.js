// src/scene/lines.js
// Highlighting and filtering for the route layer, and drawing a planned trip
// over it.
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

import { expressParent } from '../core/trunks.js';

// How far a route recedes when something else is highlighted. Faint enough to
// read as background, present enough that the network's shape survives.
const DIMMED_OPACITY = 0.12;
const NORMAL_OPACITY = 0.95;

// Stations off a selected line recede the same way, a touch less so a dot
// still reads as a station rather than noise (#160).
const DIMMED_STATION_OPACITY = 0.15;

// Every layer that draws a station dot, and the one that draws their names.
const STATION_DOT_LAYERS = [
    'station-complexes-major', 'station-complexes-minor',
    'station-circles-major', 'station-circles-minor',
];
const STATION_LABEL_LAYER = 'station-labels';
const LINE_STOPS_LAYER = 'station-line-stops';

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

/**
 * Lights up the stops of the given lines and dims every other station, or puts
 * every station back given none (#160).
 *
 * A selected line's stops are drawn as white dots at every zoom, including the
 * one-line stops the complex layers leave out at city zoom, so a whole line
 * fitted on screen shows all of it. Express routes count as their line (6X is
 * the 6). Stations carry the lines that stop there as `lines`, "|A|C|F|", set
 * by addStationLayer from line-order.json; without it nothing matches, so
 * callers pass null and nothing dims.
 *
 * @param {object} map Maplibre map
 * @param {string[]|null} lineIds
 */
export function highlightStations(map, lineIds) {
    if (!map?.getLayer?.(LINE_STOPS_LAYER)) return;
    const on = stationsOn(lineIds);

    const opacity = on ? ['case', on, 1, DIMMED_STATION_OPACITY] : 1;
    for (const layer of STATION_DOT_LAYERS) {
        map.setPaintProperty(layer, 'circle-opacity', opacity);
        map.setPaintProperty(layer, 'circle-stroke-opacity', opacity);
    }
    map.setPaintProperty(STATION_LABEL_LAYER, 'text-opacity', opacity);

    map.setFilter(LINE_STOPS_LAYER, on ?? ['boolean', false]);
    map.setLayoutProperty(LINE_STOPS_LAYER, 'visibility', on ? 'visible' : 'none');
}

/**
 * The expression that is true for a station any of these lines stops at, or
 * null for none. Exported for tests.
 */
export function stationsOn(lineIds) {
    const ids = [...new Set((lineIds ?? []).filter(Boolean).map(id => expressParent(id) ?? id))];
    if (!ids.length) return null;
    return ['any', ...ids.map(id => ['in', `|${id}|`, ['get', 'lines']])];
}

/**
 * Dims every route, for a planned trip: the trip is drawn on its own layer, so
 * even the routes it rides recede outside the stretches it uses.
 */
export function dimAllLines(map) {
    if (!map?.getLayer?.('route-lines')) return;
    map.setPaintProperty('route-lines', 'line-opacity', DIMMED_OPACITY);
}

/**
 * Draws a planned trip on the trip-path layer, or clears it given none.
 *
 * @param {object} map Maplibre map
 * @param {object[]} [features] from tripPathFeatures
 */
export function showTripPath(map, features = []) {
    map?.getSource?.('trip-path')?.setData({ type: 'FeatureCollection', features });
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
