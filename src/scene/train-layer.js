// src/scene/train-layer.js
// Live trains, as the route bullets the MTA prints on its own signs.
//
// Replaces the Three.js boxes that rode tube geometry. The boxes were colored by
// route and nothing else, which meant a rider could see *a* train but not *which*
// train without tracing the line back to its color. A bullet names it outright,
// and it is the vocabulary a New Yorker already reads.
//
// Positions come from the same derivation the meshes used — MTA publishes no
// GPS, so a vehicle is placed from its stop sequence — but against polyline
// fractions rather than curve parameters. See core/polyline.js.

import { normalizeStopId, VEHICLE_STATUS } from '../core/rt-parser.js';
import { contrastColor } from '../core/color.js';
import { preparePolyline, pointAt, nearestU, boundsOf, withinBounds } from '../core/polyline.js';
import { positionAt } from '../core/train-motion.js';

const SOURCE_ID = 'trains';
const LAYER_ID = 'trains';

// How close a station has to be to a route's line to count as on it. Carried
// over unchanged from the mesh implementation: it is a property of how loosely
// GTFS station coordinates sit against shape geometry, not of the renderer.
const STATION_MATCH_RADIUS_M = 150;

// Where a vehicle sits between its last stop and the one it is approaching.
// MTA gives a status, not a distance, so these are the same two conventions the
// meshes used.
const INCOMING_FRACTION = 0.2;
const IN_TRANSIT_FRACTION = 0.6;

// Bullets are drawn at this size and scaled down by zoom, so the canvas is big
// enough that the largest on-screen bullet is never upscaled.
const ICON_PX = 44;

// Redraws per second.
//
// Trains move at walking pace on screen, so 60 Hz buys nothing visible. It does
// cost something: with collision enabled, every rebuild re-runs symbol
// placement, and at 60 Hz that churned 14% of visible bullets per 250 ms —
// measured — which reads as flicker rather than as motion.
const REDRAW_HZ = 4;

const UNKNOWN_COLOR = '#808183';

// Fastest a train is allowed to appear to travel, in meters per second.
//
// A guard on the feed, not on the renderer. Predictions occasionally imply a
// speed nothing on rails reaches, in two distinct ways seen on one live
// snapshot: the E published consecutive stops one second apart near Jamaica,
// which turns 0.74 km into 741 m/s, and a D hop covered 3.81 km in a predicted
// 73 s. Interpolating across either produces a bullet visibly rocketing across
// the map, which reads as a bug even though the geometry is right.
//
// 40 m/s is about 90 mph, comfortably above anything NYC runs — a live snapshot
// put the median at 8.0 m/s and the 90th percentile at 11.6 — so a legitimate
// express hop is never caught by this. Only nonsense is.
const MAX_PLAUSIBLE_SPEED_MPS = 40;

// How much of the gap to a train's newly computed position to close each draw.
//
// A snapshot lands every 30 seconds and rewrites every prediction, so the
// position a train should hold can step even while it is moving smoothly. Left
// alone that is not subtle: measured over 45 seconds, the two refreshes in that
// window moved about 260 trains each in a single frame. Easing absorbs the
// correction instead of teleporting it. At the draw rate below this closes
// roughly 95% of a gap in two seconds, and it costs a lag of about five meters
// behind a train at full speed — nothing, against a position that is an estimate
// to begin with.
const CORRECTION_EASE = 0.3;

// Beyond this, snap rather than slide.
//
// A correction this large is not a correction: it means the feed re-identified
// the train, usually onto a different branch of its own route. Easing across it
// would send a bullet gliding several kilometers over open ground, which looks
// far more broken than simply appearing in the right place.
const SNAP_CORRECTION_M = 500;

/** Draws one route's bullet into an ImageData Maplibre can register. */
function bulletImage(color, label) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ICON_PX;
    const ctx = canvas.getContext('2d');

    ctx.beginPath();
    ctx.arc(ICON_PX / 2, ICON_PX / 2, ICON_PX / 2 - 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    // A dark rim, because a bullet sits on a line of its own color and would
    // otherwise dissolve into it — which is exactly how the boxes failed.
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();

    ctx.fillStyle = contrastColor(color);
    ctx.font = `700 ${label.length > 1 ? 19 : 24}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, ICON_PX / 2, ICON_PX / 2 + 1);

    return ctx.getImageData(0, 0, ICON_PX, ICON_PX);
}

/**
 * Registers one bullet image per route and adds the empty train layer.
 *
 * Inserted above the station circles but below the station labels, which is a
 * narrower slot than it sounds and both halves are load-bearing.
 *
 * Above the circles, because a bullet drawn beneath them is not a bullet: a
 * train sitting at a station is exactly concentric with that station's white
 * dot, so the first attempt rendered every arriving train as a thin colored ring
 * peeking out from behind the dot, with its letter completely hidden. A train is
 * the live information; the dot is the backdrop.
 *
 * Below the labels, because symbol placement runs in layer order and whichever
 * comes first wins the space. Trains need to win it.
 */
export function addTrainLayer(map, routeMap, beforeId = 'station-labels') {
    for (const [routeId, route] of Object.entries(routeMap ?? {})) {
        const image = bulletImage(route?.color ?? UNKNOWN_COLOR, route?.shortName ?? routeId);
        if (!map.hasImage(`train-${routeId}`)) map.addImage(`train-${routeId}`, image);
    }

    map.addSource(SOURCE_ID, { type: 'geojson', data: emptyCollection() });

    map.addLayer({
        id: LAYER_ID,
        type: 'symbol',
        source: SOURCE_ID,
        layout: {
            'icon-image': ['get', 'icon'],
            // Collision left ON, which is the whole reason the city view works.
            // With overlap allowed, 384 bullets render at zoom 11 and Manhattan
            // below 59th becomes one unreadable clot; letting Maplibre drop the
            // ones that collide leaves 136 and the network reads. The sort key
            // keeps the choice stable between frames so the survivors do not
            // reshuffle on every redraw.
            'icon-allow-overlap': false,
            'icon-ignore-placement': false,
            'icon-padding': 2,
            'symbol-sort-key': ['get', 'sortKey'],
            'icon-size': [
                'interpolate', ['linear'], ['zoom'],
                10, 0.20,
                13, 0.40,
                16, 0.72,
            ],
        },
    }, map.getLayer(beforeId) ? beforeId : undefined);
}

const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });

/**
 * Indexes, for every route, where each station falls along each of its lines.
 *
 * One entry per line rather than per route: a branching route serves stations on
 * one branch and not another, and a vehicle has to be placed on the branch it is
 * actually running.
 *
 * @param {Record<string, [number, number][][]>} lineRoutes routeId -> polylines of [lat, lng]
 * @param {{id: string, lat: number, lng: number}[]} stations
 */
export function buildRouteIndex(lineRoutes, stations) {
    const index = new Map();

    for (const [routeId, polylines] of Object.entries(lineRoutes ?? {})) {
        const lines = [];

        for (const coords of polylines ?? []) {
            // lineRoutes is [lat, lng]; polylines are [lng, lat] like GeoJSON.
            const poly = preparePolyline(coords.map(([lat, lng]) => [lng, lat]));
            if (!poly) continue;

            // The line's extent, grown by the match radius. A station outside
            // it cannot be within the radius of any segment, so the scan below
            // is skipped for it entirely.
            //
            // Exactly equivalent to scanning every station, not an
            // approximation: the scan's result is discarded unless it comes in
            // under the radius, and a station outside this box never does. A
            // route passes near a few dozen of the system's 496 stations, so
            // this rejects most of them before any distance is computed.
            //
            // Worth less than it looks on its own: a route spans miles, so its
            // box covers much of the city and only takes the build from 498 ms
            // to 407 ms. Projecting each line's coordinates once in
            // preparePolyline is what actually mattered — together they run in
            // 29 ms, with an identical 2,151 station matches.
            const bounds = boundsOf(poly, STATION_MATCH_RADIUS_M);

            const stationU = new Map();
            for (const station of stations) {
                if (!withinBounds(bounds, station.lng, station.lat)) continue;
                const { distance, u } = nearestU(poly, station.lng, station.lat);
                if (distance <= STATION_MATCH_RADIUS_M) stationU.set(station.id, u);
            }
            lines.push({ poly, stationU });
        }

        if (lines.length) index.set(routeId, lines);
    }

    return index;
}

/**
 * Which of a route's lines a vehicle is on, and where along it.
 *
 * STOPPED_AT snaps to the stop. Otherwise the position is nudged back from the
 * target along the line, with direction taken from the next predicted stop
 * rather than assumed from the line's own ordering, which has no relation to a
 * given trip's direction of travel.
 *
 * The next stop is the first entry in the sequence differing from the vehicle's
 * own, which is only the stop *ahead* because the API sends a window anchored on
 * that stop (trimStops in api/vehicles.go). An unanchored sequence still lists
 * stops the train has left, and picking one of those inverts the direction and
 * can select the branch the train came from.
 *
 * @returns {{lineIndex: number, u: number}|null} null when the stop is on no line
 */
export function deriveVehicleU(vehicle, lines) {
    const targetId = normalizeStopId(vehicle.stopId);
    const next = vehicle.stopTimeUpdate?.find(s => normalizeStopId(s.stopId) !== targetId);
    const nextId = next ? normalizeStopId(next.stopId) : null;

    let chosen = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].stationU.get(targetId) == null) continue;
        if (chosen === -1) chosen = i;
        // A line that knows where the train is going next describes this trip
        // better than one that merely contains its current stop.
        if (nextId != null && lines[i].stationU.get(nextId) != null) { chosen = i; break; }
    }
    if (chosen === -1) return null;

    const { stationU } = lines[chosen];
    const targetU = stationU.get(targetId);

    if (vehicle.currentStatus === VEHICLE_STATUS.STOPPED_AT) return { lineIndex: chosen, u: targetU };

    const nextU = nextId != null ? stationU.get(nextId) : null;
    if (nextU == null) return { lineIndex: chosen, u: targetU };

    const forward = Math.sign(nextU - targetU) || 1;
    const span = Math.abs(nextU - targetU);
    const fraction = vehicle.currentStatus === VEHICLE_STATUS.INCOMING_AT
        ? INCOMING_FRACTION
        : IN_TRANSIT_FRACTION;

    return { lineIndex: chosen, u: Math.min(1, Math.max(0, targetU - forward * fraction * span)) };
}

/**
 * Places every vehicle in a snapshot, dropping the ones no line can carry.
 *
 * Sort keys are assigned by first appearance and kept for as long as a trip
 * runs, so collision resolves the same way frame to frame. Reassigning them per
 * snapshot would make the surviving bullets reshuffle every thirty seconds.
 */
export function placeVehicles(vehicles, routeIndex, sortKeys = new Map()) {
    const placed = [];
    let nextKey = sortKeys.size;

    for (const vehicle of vehicles ?? []) {
        const lines = routeIndex.get(vehicle.routeId);
        if (!lines?.length) continue;

        const at = deriveVehicleU(vehicle, lines);
        if (at == null) continue;

        if (!sortKeys.has(vehicle.tripId)) sortKeys.set(vehicle.tripId, nextKey++);

        placed.push({
            tripId: vehicle.tripId,
            routeId: vehicle.routeId,
            line: lines[at.lineIndex].poly,
            // Where the snapshot put it. Kept as the fallback for any train the
            // predicted times cannot place — about a quarter of them, whose next
            // arrival is more than ten minutes out because the run has not
            // started. Leaving those where they are is no worse than what the
            // map showed before there was any motion at all; hiding them would
            // empty a quarter of the network off the screen.
            snapshotU: at.u,
            u: at.u,
            // The stop window and this line's index of it, so the tick can turn
            // a pair of stop ids into two places on the line.
            window: vehicle.stopTimeUpdate ?? [],
            stationU: lines[at.lineIndex].stationU,
            sortKey: sortKeys.get(vehicle.tripId),
        });
    }

    // Trips that have ended stop holding a key, or the map grows for the life of
    // the session.
    const running = new Set(placed.map(p => p.tripId));
    for (const tripId of sortKeys.keys()) if (!running.has(tripId)) sortKeys.delete(tripId);

    return placed;
}

/**
 * Advances every train to where the predicted times say it is now.
 *
 * Mutates `u` in place rather than rebuilding the list: this runs several times
 * a second and the set of trains only changes when a snapshot lands.
 *
 * @param {number} nowMs wall clock in milliseconds
 * @returns {number} how many trains the times could actually place, which is the
 *   number worth reporting — the rest are sitting where their snapshot left them
 */
export function advanceTrains(placed, nowMs, smoothing = new Map()) {
    const now = Math.floor(nowMs / 1000);
    let moved = 0;

    // Eases a train toward where it now belongs, so a refreshed prediction
    // arrives as movement rather than as a jump.
    const settle = (train, target) => {
        const previous = smoothing.get(train.tripId);
        const jumped = previous == null
            || Math.abs(target - previous) * train.line.length > SNAP_CORRECTION_M;
        train.u = jumped ? target : previous + (target - previous) * CORRECTION_EASE;
        smoothing.set(train.tripId, train.u);
    };

    for (const train of placed) {
        const at = positionAt(train.window, now);
        if (at == null) {
            // Unknown. Hold the snapshot position rather than inventing one.
            settle(train, train.snapshotU);
            continue;
        }

        const fromU = train.stationU.get(normalizeStopId(at.fromStopId));
        const toU = train.stationU.get(normalizeStopId(at.toStopId));
        // A stop the feed names but this line does not carry — a train that has
        // been rerouted, or a window spanning a branch point.
        if (fromU == null || toU == null) {
            settle(train, train.snapshotU);
            continue;
        }

        // Refuse to animate a hop the feed describes impossibly. Holding at the
        // stop it left is wrong by at most one station; showing it cross three
        // of them in a second is wrong in a way a rider would notice.
        if (at.seconds > 0) {
            const meters = Math.abs(toU - fromU) * train.line.length;
            if (meters / at.seconds > MAX_PLAUSIBLE_SPEED_MPS) {
                settle(train, fromU);
                continue;
            }
        }

        // One lerp covers all three cases, because t may be negative: that
        // extrapolates backward along the same line for a train still short of
        // its own stop. Clamped so it can never run off either end.
        settle(train, Math.min(1, Math.max(0, fromU + at.t * (toU - fromU))));
        moved++;
    }

    // Trips that have ended stop holding a smoothing entry, the same way they
    // release their sort key.
    if (smoothing.size > placed.length) {
        const running = new Set(placed.map(t => t.tripId));
        for (const tripId of smoothing.keys()) if (!running.has(tripId)) smoothing.delete(tripId);
    }

    return moved;
}

/** The GeoJSON for a set of placed vehicles. */
export function trainFeatures(placed) {
    return {
        type: 'FeatureCollection',
        features: placed.map((train) => {
            const { lng, lat } = pointAt(train.line, train.u);
            return {
                type: 'Feature',
                properties: {
                    icon: `train-${train.routeId}`,
                    routeId: train.routeId,
                    sortKey: train.sortKey,
                },
                geometry: { type: 'Point', coordinates: [lng, lat] },
            };
        }),
    };
}

/**
 * Owns the layer's data: the current snapshot, and the redraw loop.
 *
 * Kept as a small object rather than module state so a test can drive it without
 * a map, and so two maps could never share one set of trains by accident.
 */
export function createTrainState(map) {
    return {
        map,
        placed: [],
        sortKeys: new Map(),
        hidden: new Set(),
        lastDraw: 0,
        // How many trains the predicted times placed on the last draw, as
        // opposed to those holding a snapshot position.
        placeable: 0,
        // Last drawn position per trip, so a refreshed prediction is eased in
        // rather than snapped. Survives the snapshot rebuild; keyed on trip id
        // for exactly that reason.
        smoothing: new Map(),
    };
}

/** Replaces the current snapshot and redraws immediately. */
export function syncTrains(state, vehicles, routeIndex) {
    state.placed = placeVehicles(vehicles, routeIndex, state.sortKeys);
    draw(state, true);
    return state.placed.length;
}

/** Hides or shows one route's trains, following the lines panel. */
export function setTrainVisibility(state, routeId, visible) {
    if (visible) state.hidden.delete(routeId);
    else state.hidden.add(routeId);
    draw(state, true);
}

function draw(state, force = false) {
    const now = performance.now();
    if (!force && now - state.lastDraw < 1000 / REDRAW_HZ) return;
    state.lastDraw = now;

    state.placeable = advanceTrains(state.placed, Date.now(), state.smoothing);

    const source = state.map?.getSource(SOURCE_ID);
    if (!source) return;

    const visible = state.hidden.size
        ? state.placed.filter(t => !state.hidden.has(t.routeId))
        : state.placed;
    source.setData(trainFeatures(visible));
}

/**
 * Starts the redraw loop.
 *
 * Trains move between snapshots, so this runs continuously rather than only when
 * data lands: a snapshot arrives every 30 seconds and a hop takes about 105, so
 * most of what a rider sees is interpolated rather than reported. Returns a stop
 * function.
 */
export function startTrainLoop(state) {
    let running = true;
    const tick = () => {
        if (!running) return;
        draw(state);
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { running = false; };
}
