// src/scene/trains.js
// Simulated train meshes that animate along route curves.
// Reuses the curves from buildLineMeshes so trains follow the same
// paths as the tubes. Placeholder for Phase 4 real VehiclePosition data.

import * as THREE from 'three';

const TRAIN_WIDTH_M  = 5;
const TRAIN_HEIGHT_M = 4;
const TRAIN_LENGTH_M = 18;

// Creates one train mesh per route using pre-built line curves and adds each to the scene.
// Each mesh stores its curve, current t position, and speed in userData.
// mesh.up is set to world Z (the local "up" axis under geoToLocalMeters'
// convention) so lookAt orients trains correctly as they travel.
// Returns the array of train meshes for use in tickTrains.
export function buildSimulatedTrains(lineCurves, routeMap, scene) {
    const trainMeshes = [];

    for (const [routeId, curve] of lineCurves) {
        const geometry = new THREE.BoxGeometry(TRAIN_WIDTH_M, TRAIN_HEIGHT_M, TRAIN_LENGTH_M);
        const color    = routeMap[routeId]?.color ?? '#808183';
        const material = new THREE.MeshStandardMaterial({ color });

        const t    = Math.random();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.up.set(0, 0, 1);
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
// Called once per animation frame from the Maplibre custom layer's onTick.
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
