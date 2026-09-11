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

/**
 * Dims every route except one, for the popup's line highlight.
 *
 * Deliberately touches only the tubes. The highlight is driven by a station
 * popup, which is opened at close zoom where the flat line layer is already
 * hidden — so reaching it would be work with no visible effect. That stops being
 * true the moment anything highlights a route from the overview, which is
 * exactly what the trip planner will do: a selected itinerary has to read at
 * city zoom. Extend this then, rather than assuming it already works.
 */
export function highlightLine(lineMeshes, routeId) {
    for (const [id, meshes] of lineMeshes) {
        const opacity = id === routeId ? 1 : 0.08;
        for (const mesh of meshes) mesh.material.opacity = opacity;
    }
}

export function clearLineHighlight(lineMeshes) {
    for (const meshes of lineMeshes.values()) {
        for (const mesh of meshes) mesh.material.opacity = 1;
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
