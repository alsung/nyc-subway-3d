// src/scene/trains.js
// Simulated train meshes that animate along route curves.
// Reuses the curves from buildLineMeshes so trains follow the same
// Y-offset paths as the tubes. Placeholder for Phase 3 real VehiclePosition data.

import * as THREE from 'three';

// Creates one train mesh per route using pre-built line curves and adds each to the scene.
// Each mesh stores its curve, current t position, and speed in userData.
// Returns the array of train meshes for use in tickTrains.
export function buildSimulatedTrains(lineCurves, routeMap, scene) {
    const trainMeshes = [];

    for (const [routeId, curve] of lineCurves) {
        const geometry = new THREE.BoxGeometry(0.8, 0.4, 1.6);
        const color    = routeMap[routeId]?.color ?? '#808183';
        const material = new THREE.MeshStandardMaterial({ color });

        const t    = Math.random();
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

        const pos    = curve.getPoint(mesh.userData.t);
        mesh.position.copy(pos);

        const tangent = curve.getTangent(mesh.userData.t);
        mesh.lookAt(pos.clone().add(tangent));
    }
}
