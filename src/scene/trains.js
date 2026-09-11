// src/scene/trains.js
// Train meshes that animate along route curves. Two modes coexist:
//   'simulated' — a random continuous walk along the curve, used as a
//                 fallback for any route with no live vehicle data.
//   'real'      — driven by the /api/vehicles JSON feed, tweened
//                 between snapshots on each RT refresh. MTA's feed has no
//                 GPS, so positions are derived from stop-relative status —
//                 see deriveVehicleT below.

import * as THREE from 'three';
import { geoToLocalMeters } from '../core/geo.js';
import { normalizeStopId, VEHICLE_STATUS } from '../core/rt-parser.js';

const TRAIN_WIDTH_M  = 5;
const TRAIN_HEIGHT_M = 4;
const TRAIN_LENGTH_M = 18;

const STATION_MATCH_RADIUS_M = 150;
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

    for (const [routeId, curves] of lineCurves) {
        // One fallback train per route, not per branch. It stands in for "this
        // line is running" when the feed has nothing, and three dots crawling
        // the A's three branches would overstate what is actually known.
        const curve = curves[0];
        if (!curve) continue;

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
/**
 * For each route, the t-parameter of every station on each of its curves.
 *
 * One map per curve rather than one per route: a branching route has stations
 * that exist on one branch and not another, and a vehicle has to be placed on
 * the branch it is actually running.
 *
 * @returns {Map<string, Map<string, number>[]>} index-aligned with lineCurves
 */
export function buildStationTByRoute(lineCurves, stations) {
    const SAMPLE_COUNT = 2000;
    const R = STATION_MATCH_RADIUS_M;
    const R2 = R * R;
    const stationTByRoute = new Map();

    // Hoisted out of the route loop: a station's local coordinates depend only
    // on the station. Computing them inside meant 29 routes x 496 stations =
    // 14,384 conversions where 496 do.
    const stationXY = stations.map(st => {
        const { x, y } = geoToLocalMeters(st.lat, st.lng);
        return { id: st.id, x, y };
    });

    for (const [routeId, curves] of lineCurves) {
      const perCurve = [];
      for (const curve of curves ?? []) {
        // getPointAt(u) is arc-length-uniform (calls getUtoTmapping internally).
        // getSpacedPoints is t-uniform and gives uneven coverage on long routes.
        curve.arcLengthDivisions = SAMPLE_COUNT;
        const points = [];
        for (let i = 0; i <= SAMPLE_COUNT; i++) {
            points.push(curve.getPointAt(i / SAMPLE_COUNT));
        }

        // The curve's extent, grown by the match radius. A station outside this
        // box cannot be within R of any sample on the curve, so the 2001-point
        // scan below is skipped entirely for it.
        //
        // Exactly equivalent to scanning every station, not an approximation:
        // the scan's result is discarded unless the nearest sample is within R,
        // and a station outside this box has no sample within R by construction.
        //
        // This is where the time went. A route passes near a few dozen of the
        // system's 496 stations, so the box rejects the large majority of the
        // 14,384 station-route pairs before any distance is computed at all.
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        minX -= R; maxX += R; minY -= R; maxY += R;

        const stationT = new Map();
        for (const st of stationXY) {
            if (st.x < minX || st.x > maxX || st.y < minY || st.y > maxY) continue;

            // Squared distance rather than Math.hypot. hypot pays for
            // overflow-safe scaling that these values never need, and measured
            // 3.4x slower on this loop; comparing squares is order-preserving,
            // so the nearest sample is the same one either way.
            let bestD2 = Infinity;
            let bestI = 0;
            for (let i = 0; i < points.length; i++) {
                const dx = points[i].x - st.x;
                const dy = points[i].y - st.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2) {
                    bestD2 = d2;
                    bestI = i;
                }
            }

            if (bestD2 <= R2) {
                // bestI/SAMPLE_COUNT is the arc-length fraction; getUtoTmapping maps it to t.
                const t = curve.getUtoTmapping(bestI / SAMPLE_COUNT);
                stationT.set(st.id, t);
            }
        }

        perCurve.push(stationT);
      }

      stationTByRoute.set(routeId, perCurve);
    }

    return stationTByRoute;
}

// Counts how many routes' curves pass near each station, using the same
// stationTByRoute data built for vehicle positioning. Used as a simple
// "transfer hub" importance signal for station LOD (see main.js).
export function countRoutesPerStation(stationTByRoute) {
    const counts = new Map();
    for (const perCurve of stationTByRoute.values()) {
        // A station served by two branches of the same route is served by one
        // route. Counting per curve would make Broadway Junction look like a
        // bigger interchange than Times Sq.
        const seen = new Set();
        for (const stationT of perCurve) {
            for (const stationId of stationT.keys()) seen.add(stationId);
        }
        for (const stationId of seen) {
            counts.set(stationId, (counts.get(stationId) ?? 0) + 1);
        }
    }
    return counts;
}

// Derives which of a route's curves a live vehicle is on, and where along it,
// from the vehicle's stop-relative status. STOPPED_AT snaps exactly to the
// stop. Otherwise the position is nudged backward from the target stop along
// the curve, with direction determined empirically from the next predicted stop
// (rather than assumed from the curve's arbitrary parameterization, which may
// not match this trip's direction of travel).
//
// Branch selection is what the curve index is for. A Rockaway-bound A and a
// Lefferts-bound A share a route id and diverge at Rockaway Blvd, so the stop
// the train is heading to is the only thing that says which track it is on.
// Curves carrying both the target and the next stop are preferred, since a stop
// shared by two branches (everything before the split) says nothing on its own.
//
// Returns { curveIndex, t }, or null if the target stop is on none of them.
export function deriveVehicleT(vehicle, stationTs) {
    const targetId = normalizeStopId(vehicle.stopId);
    const next = vehicle.stopTimeUpdate?.find(s => normalizeStopId(s.stopId) !== targetId);
    const nextId = next ? normalizeStopId(next.stopId) : null;

    let chosen = -1;
    for (let i = 0; i < stationTs.length; i++) {
        if (stationTs[i].get(targetId) == null) continue;
        if (chosen === -1) chosen = i;
        // A curve that knows where the train is going next describes this trip
        // better than one that merely contains its current stop.
        if (nextId != null && stationTs[i].get(nextId) != null) { chosen = i; break; }
    }
    if (chosen === -1) return null;

    const stationT = stationTs[chosen];
    const targetT = stationT.get(targetId);

    if (vehicle.currentStatus === VEHICLE_STATUS.STOPPED_AT) return { curveIndex: chosen, t: targetT };

    const nextT = nextId != null ? stationT.get(nextId) : null;
    if (nextT == null) return { curveIndex: chosen, t: targetT };

    const forwardSign = Math.sign(nextT - targetT) || 1;
    const span = Math.abs(nextT - targetT);
    const fraction = vehicle.currentStatus === VEHICLE_STATUS.INCOMING_AT
        ? INCOMING_FRACTION
        : IN_TRANSIT_FRACTION;

    return { curveIndex: chosen, t: Math.min(1, Math.max(0, targetT - forwardSign * fraction * span)) };
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
        const curves = lineCurves.get(vehicle.routeId);
        const stationTs = stationTByRoute.get(vehicle.routeId);
        if (!curves?.length || !stationTs?.length) continue;

        const placed = deriveVehicleT(vehicle, stationTs);
        if (placed == null) continue;

        const curve = curves[placed.curveIndex];
        if (!curve) continue;

        routesWithReal.add(vehicle.routeId);
        seenTripIds.add(vehicle.tripId);

        const targetPos = curve.getPoint(placed.t);
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
