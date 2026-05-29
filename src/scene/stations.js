// src/scene/stations.js
// Builds station marker meshes and handles raycaster hit detection.
// Each mesh carries its station data in userData for identification on click.

import * as THREE from 'three';
import { geoToXZ } from '../core/geo.js';

// Creates a flat cylinder disc for every station and adds each to the scene.
// Returns the array of meshes for raycasting in getHitStation.
export function buildStationMeshes(stations, scene) {
    const geometry = new THREE.CylinderGeometry(0.3, 0.3, 0.4, 8);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const meshes = [];

    for (const station of stations) {
        const { x, z } = geoToXZ(station.lat, station.lng);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, 0.2, z);
        mesh.userData.station = station;
        scene.add(mesh);
        meshes.push(mesh);
    }

    return meshes;
}

// Returns the station object under the raycaster, or null if nothing was hit.
// Called from main.js on every canvas click event.
export function getHitStation(stationMeshes, raycaster) {
    const intersects = raycaster.intersectObjects(stationMeshes);
    return intersects[0]?.object.userData.station ?? null;
}
