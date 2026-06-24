// src/scene/stations.js
// Builds station marker meshes and finds the station nearest a map click.
//
// Three.js raycasting against mesh geometry isn't used here — the camera's
// projection matrix is supplied externally by Maplibre each frame (see
// renderer.js), so there's no stable camera transform to unproject screen
// coordinates through. Maplibre already resolves click positions to lng/lat
// for us, so hit-testing is just "nearest station within a small radius."

import * as THREE from 'three';
import { geoToLocalMeters, haversineKm } from '../core/geo.js';

const STATION_RADIUS_M = 12;
const STATION_HEIGHT_M = 4;
const CLICK_RADIUS_KM  = 0.05;

// Creates a flat disc for every station and adds each to the scene.
// Rotated 90° about X so the cylinder's axis points along world Z (up),
// matching the local coordinate convention used by geoToLocalMeters.
export function buildStationMeshes(stations, scene) {
    const geometry = new THREE.CylinderGeometry(STATION_RADIUS_M, STATION_RADIUS_M, STATION_HEIGHT_M, 16);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const meshes = [];

    for (const station of stations) {
        const { x, y } = geoToLocalMeters(station.lat, station.lng);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = Math.PI / 2;
        mesh.position.set(x, y, STATION_HEIGHT_M / 2);
        mesh.userData.station = station;
        scene.add(mesh);
        meshes.push(mesh);
    }

    return meshes;
}

// Returns the station nearest to lngLat (a Maplibre LngLat from a click event),
// or null if nothing is within CLICK_RADIUS_KM.
export function getStationAt(stations, lngLat) {
    let closest = null;
    let closestDist = Infinity;

    for (const station of stations) {
        const dist = haversineKm(
            { lat: station.lat, lng: station.lng },
            { lat: lngLat.lat, lng: lngLat.lng }
        );
        if (dist < closestDist) {
            closestDist = dist;
            closest = station;
        }
    }

    return closestDist <= CLICK_RADIUS_KM ? closest : null;
}
