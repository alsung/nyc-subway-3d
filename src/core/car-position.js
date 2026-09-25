// src/core/car-position.js
// Recommends which part of a train to board for the fastest exit.
//
// At build time, build-car-positions.mjs precomputes each platform's principal
// axis and projects nearby entrances onto it. At runtime this module takes a
// trip plan leg and determines the train's approach direction at the
// destination, then maps each entrance to front/middle/back.

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos(40.73 * Math.PI / 180);

/**
 * Indexes the car-positions.json array by complex id for O(1) lookup.
 *
 * @param {Array} raw  The parsed JSON array
 * @returns {Map<string, object[]>}  complex id → array of platform objects
 */
export function indexCarPositions(raw) {
    const map = new Map();
    if (!Array.isArray(raw)) return map;
    for (const entry of raw) {
        if (entry?.c && Array.isArray(entry.p)) {
            map.set(String(entry.c), entry.p);
        }
    }
    return map;
}

/**
 * Car positioning advice for a ride leg's destination.
 *
 * @param {object}   leg        A ride leg from the plan API (has stops[], routeId)
 * @param {Function} complexFor  GTFS stop id → MTA complex id
 * @param {Function} stationFor  GTFS stop id (parent) → {lat, lng}
 * @param {Map}      carPositions  From indexCarPositions
 * @returns {object[]|null}  Per-entrance recommendations, or null when unavailable
 */
export function carAdvice(leg, complexFor, stationFor, carPositions) {
    if (leg?.kind !== 'ride') return null;

    const stops = leg.stops;
    if (!Array.isArray(stops) || stops.length < 2) return null;

    const destId = stripDirection(stops[stops.length - 1]);
    const prevId = stripDirection(stops[stops.length - 2]);

    const complexId = complexFor(destId);
    if (!complexId) return null;

    const platforms = carPositions.get(complexId);
    if (!platforms?.length) return null;

    const dest = stationFor(destId);
    const prev = stationFor(prevId);
    if (!dest || !prev) return null;

    const dx = (dest.lng - prev.lng) * M_PER_DEG_LNG;
    const dy = (dest.lat - prev.lat) * M_PER_DEG_LAT;
    if (Math.hypot(dx, dy) < 1) return null;

    const platform = closestPlatform(platforms, dest.lat, dest.lng);
    if (!platform || !platform.e?.length) return null;

    const dot = platform.ax[0] * dx + platform.ax[1] * dy;
    const frontAtHighU = dot > 0;

    return platform.e.map(e => ({
        u: e.u,
        type: e.t,
        region: classify(e.u, frontAtHighU),
    }));
}

/**
 * Best single recommendation for a leg: which region to board, and why.
 *
 * Picks the entrance with the strongest signal (furthest from the middle).
 * When multiple entrances cluster in the same region, counts them.
 */
export function bestAdvice(adviceList) {
    if (!adviceList?.length) return null;

    const byRegion = { front: [], middle: [], back: [] };
    for (const a of adviceList) byRegion[a.region]?.push(a);

    // The strongest recommendation is the region with exits furthest from center.
    // "Board the front" is only useful if exits are actually concentrated there.
    let best = null;
    let bestScore = -1;
    for (const [region, entries] of Object.entries(byRegion)) {
        if (!entries.length || region === 'middle') continue;
        const score = entries.length;
        if (score > bestScore) {
            bestScore = score;
            best = { region, count: entries.length, hasElevator: entries.some(e => e.type === 'elevator') };
        }
    }

    return best;
}

function stripDirection(stopId) {
    return String(stopId ?? '').replace(/[NS]$/, '');
}

function closestPlatform(platforms, lat, lng) {
    let best = null;
    let bestDist = Infinity;
    for (const p of platforms) {
        if (!p.e?.length) continue;
        const dlat = (lat - p.cx[1]) * M_PER_DEG_LAT;
        const dlng = (lng - p.cx[0]) * M_PER_DEG_LNG;
        const d = dlat * dlat + dlng * dlng;
        if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
}

function classify(u, frontAtHighU) {
    if (frontAtHighU) {
        return u > 0.67 ? 'front' : u > 0.33 ? 'middle' : 'back';
    }
    return u < 0.33 ? 'front' : u < 0.67 ? 'middle' : 'back';
}
