// src/scene/lines.js
// Builds and manages the 3D tube geometry for every subway route.
// Depends on the parsed GTFS data from the data layer — no DOM, no UI.

import * as THREE from 'three';
import { geoToXZ, downsample } from '../core/geo.js';

// Builds one TubeGeometry mesh per route from lineRoutes and adds each to the scene.
// Returns a Map<routeId, mesh> for visibility toggling by the filter UI.
export function buildLineMeshes(lineRoutes, routeMap, scene) {
    const lineMeshes = new Map();

    for (const routeId in lineRoutes) {
        const coords = lineRoutes[routeId];

        const points = coords.map(([lat, lng]) => {
            const { x, z } = geoToXZ(lat, lng);
            return new THREE.Vector3(x, 0, z);
        });

        if (points.length < 2) continue;

        const sampled = downsample(points, 300);
        const curve = new THREE.CatmullRomCurve3(sampled);
        const geometry = new THREE.TubeGeometry(curve, 200, 0.11, 5, false);

        const color = routeMap[routeId]?.color ?? '#808183';
        const material = new THREE.MeshStandardMaterial({
            color,
            transparent: true,
            opacity: 1,
        });

        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        lineMeshes.set(routeId, mesh);
    }

    return lineMeshes;
}

// Shows or hides a single route's tube mesh.
// Called by the filter chip UI when a line is toggled on or off.
export function setLineVisibility(lineMeshes, routeId, visible) {
    const mesh = lineMeshes.get(routeId);
    if (mesh) mesh.visible = visible;
}
