import * as THREE from 'three';
import { geoToLocalMeters, downsample } from '../core/geo.js';

const TUBE_RADIUS_M = 6;

/**
 * Builds a tube per polyline, grouped by route.
 *
 * A route is several polylines when it branches, and each branch is its own
 * tube and its own curve: they diverge in space, so one curve cannot describe
 * both, and a train is only ever on one of them.
 *
 * @param {Record<string, [number, number][][]>} lineRoutes routeId -> polylines
 * @returns {{lineMeshes: Map<string, THREE.Mesh[]>, lineCurves: Map<string, THREE.Curve[]>}}
 */
export function buildLineMeshes(lineRoutes, routeMap, scene) {
    const lineMeshes = new Map();
    const lineCurves = new Map();

    for (const [routeId, polylines] of Object.entries(lineRoutes)) {
        if (!Array.isArray(polylines)) continue;

        const meshes = [];
        const curves = [];
        const color = routeMap[routeId]?.color ?? '#808183';

        for (const coords of polylines) {
            if (!coords || coords.length < 2) continue;

            const raw = coords.map(([lat, lng]) => {
                const { x, y } = geoToLocalMeters(lat, lng);
                return new THREE.Vector3(x, y, 0);
            });
            const sampled = downsample(raw, 300);

            const curve    = new THREE.CatmullRomCurve3(sampled);
            const geometry = new THREE.TubeGeometry(curve, 200, TUBE_RADIUS_M, 5, false);
            // One material per tube rather than one per route: highlightLine
            // and setLineVisibility mutate opacity, and sharing would make a
            // branch impossible to dim on its own later.
            const material = new THREE.MeshStandardMaterial({
                color,
                transparent: true,
                opacity: 1,
            });

            const mesh = new THREE.Mesh(geometry, material);
            scene.add(mesh);
            meshes.push(mesh);
            curves.push(curve);
        }

        if (meshes.length) {
            lineMeshes.set(routeId, meshes);
            lineCurves.set(routeId, curves);
        }
    }

    return { lineMeshes, lineCurves };
}

// How far a route recedes when something else is highlighted. Faint enough to
// read as background, present enough that the network's shape survives.
const DIMMED_OPACITY = 0.08;
const DIMMED_LINE_OPACITY = 0.12;

/**
 * Dims every route except the given ones, in **both** representations.
 *
 * This used to touch only the tubes, which was correct while the only caller was
 * the station popup: that opens at close zoom, where the flat line layer is
 * already hidden. The trip planner broke that assumption exactly as the old
 * comment here predicted it would — an itinerary is framed at city zoom, where
 * the tubes are hidden and the flat layer is the only thing drawn. Highlighting
 * only the meshes produced no visible change at all.
 *
 * @param {Map<string, THREE.Mesh[]>} lineMeshes
 * @param {string|string[]} routeIds
 * @param {object} [map] Maplibre map; omit to leave the flat layer alone
 */
export function highlightLine(lineMeshes, routeIds, map) {
    const wanted = new Set(Array.isArray(routeIds) ? routeIds : [routeIds]);

    for (const [id, meshes] of lineMeshes) {
        const opacity = wanted.has(id) ? 1 : DIMMED_OPACITY;
        for (const mesh of meshes) mesh.material.opacity = opacity;
    }

    if (!map?.getLayer?.('route-lines')) return;
    // Every feature carries routeId, from the corridor work — so the flat layer
    // can be dimmed by expression without touching its geometry.
    map.setPaintProperty('route-lines', 'line-opacity', [
        'case',
        ['in', ['get', 'routeId'], ['literal', [...wanted]]], 0.95,
        DIMMED_LINE_OPACITY,
    ]);
}

export function clearLineHighlight(lineMeshes, map) {
    for (const meshes of lineMeshes.values()) {
        for (const mesh of meshes) mesh.material.opacity = 1;
    }
    if (map?.getLayer?.('route-lines')) {
        map.setPaintProperty('route-lines', 'line-opacity', 0.95);
    }
}

/**
 * Shows or hides one route in **both** of its representations.
 *
 * A route is drawn twice — as a Three.js tube above the swap zoom and as a
 * Maplibre line layer below it — so a filter that reaches only the meshes leaves
 * the line on screen at overview zoom. The map argument exists to make that
 * impossible to forget.
 *
 * Maplibre has no per-feature visibility, so the flat layer is filtered by the
 * set of hidden route ids instead.
 */
const hiddenRoutes = new Set();

export function setLineVisibility(lineMeshes, map, routeId, visible) {
    for (const mesh of lineMeshes.get(routeId) ?? []) mesh.visible = visible;

    if (visible) hiddenRoutes.delete(routeId);
    else hiddenRoutes.add(routeId);

    if (map?.getLayer('route-lines')) {
        map.setFilter('route-lines',
            hiddenRoutes.size === 0
                ? null
                : ['!', ['in', ['get', 'routeId'], ['literal', [...hiddenRoutes]]]]);
    }
}
