// src/core/trip-path.js
// The parts of the map a planned trip actually uses, as GeoJSON features.
//
// The trip planner used to highlight whole routes, so a trip riding the N for
// four stops lit the N from Astoria to Coney Island. Each ride leg is now cut
// out of its route's own shape between the leg's first and last stop, and split
// wherever the route changes strand, so it lands on the same line-offset as the
// route drawn beneath it. Walks between two stations are drawn as their own
// feature, and a walk within one station draws nothing.
//
// No DOM or map code, so it can be tested on the real shapes.

import { preparePolyline, nearestU, slice } from './polyline.js';
import { expressParent } from './trunks.js';

// How close a stop has to be to a shape to count as on it. The same radius the
// train layer uses to place stations on their routes.
const STOP_MATCH_RADIUS_M = 150;

const UNKNOWN_ROUTE_COLOR = '#808183';

const parentId = (stopId) => String(stopId).replace(/[NS]$/, '');

const lineFeature = (coordinates, properties) => ({
    type: 'Feature',
    properties,
    geometry: { type: 'LineString', coordinates },
});

/**
 * The shape a leg rides: the one of the route's polylines that passes the most
 * of its stops, and has both its ends on it. That is what picks the right
 * branch, the A to Lefferts Blvd rather than to Far Rockaway.
 *
 * @returns {{poly: object, index: number, uFrom: number, uTo: number}|null}
 */
function shapeForLeg(polylines, points) {
    let best = null;
    (polylines ?? []).forEach((coords, index) => {
        const poly = preparePolyline((coords ?? []).map(([lat, lng]) => [lng, lat]));
        if (!poly) return;
        const hits = points.map(p => nearestU(poly, p.lng, p.lat));
        const first = hits[0];
        const last = hits[hits.length - 1];
        if (first.distance > STOP_MATCH_RADIUS_M || last.distance > STOP_MATCH_RADIUS_M) return;
        const score = hits.filter(h => h.distance <= STOP_MATCH_RADIUS_M).length;
        if (!best || score > best.score) best = { poly, index, uFrom: first.u, uTo: last.u, score };
    });
    return best;
}

/**
 * One ride leg, as one feature per strand it runs on. Falls back to straight
 * lines between the stops for a route with no shape that reaches both ends.
 */
function rideFeatures(leg, { lineRoutes, corridors, stationById, routeMap }) {
    const points = (leg.stops?.length ? leg.stops : [leg.fromStop, leg.toStop])
        .filter(Boolean)
        .map(id => stationById?.get(parentId(id)))
        .filter(Boolean);
    if (points.length < 2) return [];

    // An express pattern (6X, 7X, FX) runs on its line's shape.
    const shapeId = lineRoutes?.[leg.routeId] ? leg.routeId : (expressParent(leg.routeId) ?? leg.routeId);
    const color = routeMap?.[leg.routeId]?.color ?? routeMap?.[shapeId]?.color ?? UNKNOWN_ROUTE_COLOR;
    const properties = { kind: 'ride', routeId: leg.routeId, color };

    const shape = shapeForLeg(lineRoutes?.[shapeId], points);
    if (!shape) return [lineFeature(points.map(p => [p.lng, p.lat]), { ...properties, rank: 0 })];

    const { poly, index } = shape;
    const last = poly.coords.length - 1;
    const segments = corridors?.get(shapeId)?.[index] ?? [{ from: 0, to: last, rank: 0, flip: false }];
    const lo = Math.min(shape.uFrom, shape.uTo);
    const hi = Math.max(shape.uFrom, shape.uTo);

    const features = [];
    for (const segment of segments) {
        // The same span segmentCoords draws for this strand, one shared vertex
        // included, as fractions of the line.
        const start = Math.max(lo, poly.cumulative[Math.max(0, segment.from - 1)] / poly.length);
        const end = Math.min(hi, poly.cumulative[Math.min(last, segment.to)] / poly.length);
        if (!(end > start)) continue;
        const coords = slice(poly, start, end);
        features.push(lineFeature(segment.flip ? coords.reverse() : coords, { ...properties, rank: segment.rank }));
    }
    return features;
}

/** A walk between two stations, or null for a walk within one. */
function walkFeature(leg, stationById) {
    if (!leg.fromStop || !leg.toStop) return null;
    const from = parentId(leg.fromStop);
    const to = parentId(leg.toStop);
    if (from === to) return null;
    const a = stationById?.get(from);
    const b = stationById?.get(to);
    if (!a || !b) return null;
    return lineFeature([[a.lng, a.lat], [b.lng, b.lat]], { kind: 'walk', rank: 0 });
}

/**
 * The features for a journey from the plan API.
 *
 * @param {{legs: object[]}} journey
 * @param {object} deps
 * @param {Record<string, [number, number][][]>} deps.lineRoutes routeId -> polylines of [lat, lng]
 * @param {Map<string, object[][]>} [deps.corridors] from buildCorridors, for the strands
 * @param {Map<string, {lat: number, lng: number}>} deps.stationById parent station id -> station
 * @param {Record<string, {color?: string}>} [deps.routeMap]
 * @returns {object[]} rides carry kind 'ride', routeId, color and rank; walks carry kind 'walk'
 */
export function tripPathFeatures(journey, deps) {
    const features = [];
    for (const leg of journey?.legs ?? []) {
        if (leg.kind === 'ride') features.push(...rideFeatures(leg, deps));
        else if (leg.kind === 'walk') {
            const walk = walkFeature(leg, deps.stationById);
            if (walk) features.push(walk);
        }
    }
    return features;
}
