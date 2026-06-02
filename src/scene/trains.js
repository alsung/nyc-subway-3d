// src/scene/trains.js
// Simulated train meshes that animate along route curves.
// Placeholder for Phase 3 real VehiclePosition data from GTFS-RT.

import * as THREE from 'three';
import { geoToXZ, downsample } from '../core/geo.js';

// Creates one train mesh per route and adds each to the scene.
// Each mesh stores its curve, current t position, and speed in userData.
// Returns the array of train meshes for use in tickTrains.
export function buildSimulatedTrains(lineRoutes, routeMap, scene) {
    const trainMeshes = [];

    for (const routeId in lineRoutes) {
        const coords = lineRoutes[routeId];

        const points = coords.map(([lat, lng]) => {
            const { x, z } = geoToXZ(lat, lng);
            return new THREE.Vector3(x, 0, z);
        });

        if (points.length < 2) continue;

        const sampled = downsample(points, 300);
        const curve = new THREE.CatmullRomCurve3(sampled);

        const geometry = new THREE.BoxGeometry(0.8, 0.4, 1.6);
        const color = routeMap[routeId]?.color ?? '#808183';
        const material = new THREE.MeshStandardMaterial({ color });

        const t = Math.random();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(curve.getPoint(t));
        mesh.userData = {
            curve,
            t,
            speed: 0.004 + Math.random() * 0.002,
        };

        scene.add(mesh);
        trainMeshes.push(mesh);
    }

    return trainMeshes;
}

// Advances every train along its curve by delta and updates position and orientation.
// Called once per animation frame from main.js with the clock delta.
export function tickTrains(trainMeshes, delta) {
    for (const mesh of trainMeshes) {
        const { curve } = mesh.userData;

        mesh.userData.t = (mesh.userData.t + delta * mesh.userData.speed) % 1;

        const pos = curve.getPoint(mesh.userData.t);
        mesh.position.copy(pos);

        const tangent = curve.getTangent(mesh.userData.t);
        mesh.lookAt(pos.clone().add(tangent));
    }
}
