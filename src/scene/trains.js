// src/scene/trains.js
// Train meshes that animate along route curves. Two modes coexist:
//   'simulated' — a random continuous walk along the curve, used as a
//                 fallback for any route with no live vehicle data.
//   'real'      — driven by parseVehiclePositions (rt-parser.js), tweened
//                 between snapshots on each RT refresh. MTA's feed has no
//                 GPS, so positions are derived from stop-relative status —
//                 see deriveVehicleT below.

import * as THREE from 'three';
import { geoToLocalMeters } from '../core/geo.js';
import { normalizeStopId, VEHICLE_STATUS } from '../core/rt-parser.js';

const TRAIN_WIDTH_M  = 5;
const TRAIN_HEIGHT_M = 4;
const TRAIN_LENGTH_M = 18;

const STATION_MATCH_RADIUS_M = 50;
const INCOMING_FRACTION      = 0.2;
const IN_TRANSIT_FRACTION    = 0.6;
const TWEEN_DURATION_MS      = 4000;

function createTrainMesh(routeId, routeMap, scene) {
    const geometry = new THREE.BoxGeometry(TRAIN_WIDTH_M, TRAIN_HEIGHT_M, TRAIN_LENGTH_M);
    const color    = routeMap[routeId]?.color ?? '#808183';
    const material = new THREE.MeshStandardMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.up.set(0, 0, 1);
    scene.add(mesh);
    return mesh;
}

function disposeTrainMesh(mesh, scene) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
}

// Creates one randomly-paced simulated train per route and adds each to the
// scene. Used at startup, before the first RT refresh resolves, and as a
// permanent fallback for any route that never gets live vehicle data.
export function buildSimulatedTrains(lineCurves, routeMap, scene) {
    const trainMeshes = [];

    for (const [routeId, curve] of lineCurves) {
        const mesh = createTrainMesh(routeId, routeMap, scene);
        const t = Math.random();
        mesh.position.copy(curve.getPoint(t));
        mesh.userData = {
            mode: 'simulated',
            routeId,
            curve,
            t,
            speed: 0.004 + Math.random() * 0.002,
        };
        trainMeshes.push(mesh);
    }

    return trainMeshes;
}

// Advances simulated trains by delta and tweens real trains toward their
// latest known snapshot position. Called once per animation frame.
export function tickTrains(trainMeshes, delta) {
    const now = performance.now();

    for (const mesh of trainMeshes) {
        const d = mesh.userData;

        if (d.mode === 'simulated') {
            d.t = (d.t + delta * d.speed) % 1;
            const pos = d.curve.getPoint(d.t);
            mesh.position.copy(pos);
            mesh.lookAt(pos.clone().add(d.curve.getTangent(d.t)));
        } else if (d.mode === 'real') {
            const raw = Math.min((now - d.tweenStart) / d.tweenDuration, 1);
            mesh.position.lerpVectors(d.fromPos, d.toPos, raw);
            const dir = d.toPos.clone().sub(d.fromPos);
            if (dir.lengthSq() > 1e-4) mesh.lookAt(mesh.position.clone().add(dir));
        }
    }
}

// Precomputes, for each route's curve, the t-parameter of every station that
// lies on it (within STATION_MATCH_RADIUS_M of the sampled curve). Built once
// at scene-build time so live vehicle positions can be resolved by stopId
// without per-frame geometry search.
export function buildStationTByRoute(lineCurves, stations) {
    const SAMPLE_COUNT = 2000;
    const stationTByRoute = new Map();

    for (const [routeId, curve] of lineCurves) {
        // Arc-length-uniform sampling so long tunnel sections (few GPS points,
        // large t-span) get the same sample density as dense surface sections.
        curve.arcLengthDivisions = SAMPLE_COUNT;
        const points = curve.getSpacedPoints(SAMPLE_COUNT);

        const stationT = new Map();
        for (const station of stations) {
            const { x, y } = geoToLocalMeters(station.lat, station.lng);
            let bestDist = Infinity;
            let bestI = 0;

            for (let i = 0; i < points.length; i++) {
                const dist = Math.hypot(points[i].x - x, points[i].y - y);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestI = i;
                }
            }

            if (bestDist <= STATION_MATCH_RADIUS_M) {
                // Convert arc-length index back to curve t via the precomputed
                // length table so deriveVehicleT gets an accurate t-value.
                const t = curve.getUtoTmapping(bestI / SAMPLE_COUNT);
                stationT.set(station.id, t);
            }
        }

        stationTByRoute.set(routeId, stationT);
    }

    return stationTByRoute;
}

// Counts how many routes' curves pass near each station, using the same
// stationTByRoute data built for vehicle positioning. Used as a simple
// "transfer hub" importance signal for station LOD (see main.js).
export function countRoutesPerStation(stationTByRoute) {
    const counts = new Map();
    for (const stationT of stationTByRoute.values()) {
        for (const stationId of stationT.keys()) {
            counts.set(stationId, (counts.get(stationId) ?? 0) + 1);
        }
    }
    return counts;
}

// Derives a t-position on the route curve for a live vehicle from its
// stop-relative status. STOPPED_AT snaps exactly to the stop. Otherwise the
// position is nudged backward from the target stop along the curve, with
// direction determined empirically from the next predicted stop (rather than
// assumed from the curve's arbitrary parameterization, which may not match
// this trip's direction of travel). Returns null if the target stop can't be
// resolved to a point on this route's curve.
export function deriveVehicleT(vehicle, stationT) {
    const targetId = normalizeStopId(vehicle.stopId);
    const targetT = stationT.get(targetId);
    if (targetT == null) return null;

    if (vehicle.currentStatus === VEHICLE_STATUS.STOPPED_AT) return targetT;

    const next = vehicle.stopTimeUpdate.find(s => normalizeStopId(s.stopId) !== targetId);
    const nextT = next ? stationT.get(normalizeStopId(next.stopId)) : null;
    if (nextT == null) return targetT;

    const forwardSign = Math.sign(nextT - targetT) || 1;
    const span = Math.abs(nextT - targetT);
    const fraction = vehicle.currentStatus === VEHICLE_STATUS.INCOMING_AT
        ? INCOMING_FRACTION
        : IN_TRANSIT_FRACTION;

    return Math.min(1, Math.max(0, targetT - forwardSign * fraction * span));
}

// Syncs real-mode train meshes to the latest vehicle snapshot: updates
// existing trains' tween targets, creates meshes for newly-seen trips,
// removes meshes for trips no longer running, and removes any simulated
// fallback train for a route that now has at least one real vehicle.
// Mutates and returns trainMeshes.
export function syncRealTrains(trainMeshes, vehicles, lineCurves, stationTByRoute, routeMap, scene) {
    const seenTripIds = new Set();
    const routesWithReal = new Set();
    const now = performance.now();

    for (const vehicle of vehicles) {
        const curve = lineCurves.get(vehicle.routeId);
        const stationT = stationTByRoute.get(vehicle.routeId);
        if (!curve || !stationT) continue;

        const t = deriveVehicleT(vehicle, stationT);
        if (t == null) continue;

        routesWithReal.add(vehicle.routeId);
        seenTripIds.add(vehicle.tripId);

        const targetPos = curve.getPoint(t);
        let mesh = trainMeshes.find(m => m.userData.mode === 'real' && m.userData.tripId === vehicle.tripId);

        if (!mesh) {
            mesh = createTrainMesh(vehicle.routeId, routeMap, scene);
            mesh.position.copy(targetPos);
            mesh.userData = {
                mode: 'real',
                routeId: vehicle.routeId,
                tripId: vehicle.tripId,
                fromPos: targetPos.clone(),
                toPos: targetPos.clone(),
                tweenStart: now,
                tweenDuration: TWEEN_DURATION_MS,
            };
            trainMeshes.push(mesh);
        } else {
            mesh.userData.fromPos = mesh.position.clone();
            mesh.userData.toPos = targetPos;
            mesh.userData.tweenStart = now;
        }
    }

    for (let i = trainMeshes.length - 1; i >= 0; i--) {
        const d = trainMeshes[i].userData;
        const staleReal = d.mode === 'real' && !seenTripIds.has(d.tripId);
        const supersededSimulated = d.mode === 'simulated' && routesWithReal.has(d.routeId);

        if (staleReal || supersededSimulated) {
            disposeTrainMesh(trainMeshes[i], scene);
            trainMeshes.splice(i, 1);
        }
    }

    return trainMeshes;
}
