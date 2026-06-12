import * as THREE from 'three';
import { geoToXZ, downsample } from '../core/geo.js';

export function buildLineMeshes(lineRoutes, routeMap, scene) {
    const lineMeshes = new Map();
    const lineCurves = new Map();

    for (const [routeId, coords] of Object.entries(lineRoutes)) {
        if (coords.length < 2) continue;

        const raw = coords.map(([lat, lng]) => {
            const { x, z } = geoToXZ(lat, lng);
            return new THREE.Vector3(x, 0, z);
        });
        const sampled = downsample(raw, 300);

        const curve    = new THREE.CatmullRomCurve3(sampled);
        const geometry = new THREE.TubeGeometry(curve, 200, 0.11, 5, false);
        const color    = routeMap[routeId]?.color ?? '#808183';
        const material = new THREE.MeshStandardMaterial({
            color,
            transparent: true,
            opacity: 1,
        });

        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        lineMeshes.set(routeId, mesh);
        lineCurves.set(routeId, curve);
    }

    return { lineMeshes, lineCurves };
}

export function highlightLine(lineMeshes, routeId) {
    for (const [id, mesh] of lineMeshes) {
        mesh.material.opacity = id === routeId ? 1 : 0.08;
    }
}

export function clearLineHighlight(lineMeshes) {
    for (const mesh of lineMeshes.values()) {
        mesh.material.opacity = 1;
    }
}

export function setLineVisibility(lineMeshes, routeId, visible) {
    const mesh = lineMeshes.get(routeId);
    if (mesh) mesh.visible = visible;
}
