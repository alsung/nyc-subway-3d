// src/core/polyline.js
// Arc-length parameterized polylines, in lng/lat.
//
// Replaces THREE.CatmullRomCurve3, which the route tubes and the trains riding
// them were built on. A curve bought interpolation this map never needed —
// GTFS shape points are already dense, 5-30 m apart — and cost a dependency, a
// second coordinate space, and a sampling step: positioning a vehicle meant
// asking a curve for 2,001 sample points and scanning them.
//
// Everything here works directly on the feed's own coordinates and is exact
// rather than sampled. The u parameter is fraction of length travelled, so
// pointAt(poly, 0.5) is the true midpoint of the line rather than the midpoint
// of its parameter range.

// Meters per degree, at NYC's latitude. Distances here decide station matching
// and how far a train has travelled, both over a few hundred meters at most, so
// a local flat-earth approximation is well inside the error that matters.
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos(40.73 * Math.PI / 180);

const toMeters = ([lng, lat]) => [lng * M_PER_DEG_LNG, lat * M_PER_DEG_LAT];

/**
 * Measures a polyline once, so every later query is a binary search.
 *
 * @param {[number, number][]} coords [lng, lat] pairs
 * @returns {{coords: [number, number][], cumulative: number[], length: number}|null}
 *   null for anything that is not a line — a single point has no direction and
 *   nothing can be positioned along it.
 */
export function preparePolyline(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return null;

    // Projected once here rather than inside every query. nearestU walks every
    // segment for every candidate station, so converting on the fly meant two
    // array allocations per segment per station — which is where the time in
    // this module actually went.
    const metric = coords.map(toMeters);

    const cumulative = [0];
    for (let i = 1; i < coords.length; i++) {
        cumulative.push(cumulative[i - 1] + Math.hypot(
            metric[i][0] - metric[i - 1][0],
            metric[i][1] - metric[i - 1][1],
        ));
    }

    const length = cumulative[cumulative.length - 1];
    // A polyline whose points are all identical measures zero and would divide
    // by zero in every query below.
    if (!(length > 0)) return null;

    return { coords, metric, cumulative, length };
}

// The segment containing a given distance along the line. Binary search rather
// than a scan: a route polyline runs to a few thousand points and this is called
// once per train per frame.
function segmentAt(poly, meters) {
    let lo = 0;
    let hi = poly.cumulative.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (poly.cumulative[mid] <= meters) lo = mid;
        else hi = mid;
    }
    const span = poly.cumulative[hi] - poly.cumulative[lo];
    return { lo, hi, t: span > 0 ? (meters - poly.cumulative[lo]) / span : 0 };
}

const clampU = (u) => (Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0);

/**
 * The point at fraction u of the line's length.
 *
 * @returns {{lng: number, lat: number}}
 */
export function pointAt(poly, u) {
    const { lo, hi, t } = segmentAt(poly, clampU(u) * poly.length);
    const a = poly.coords[lo];
    const b = poly.coords[hi];
    return {
        lng: a[0] + t * (b[0] - a[0]),
        lat: a[1] + t * (b[1] - a[1]),
    };
}

/**
 * Heading at fraction u, in degrees clockwise from north.
 *
 * Taken from the containing segment rather than from a tangent, because the
 * line is what is drawn: a heading that disagreed with the segment beneath it
 * would point a train off its own track.
 */
export function bearingAt(poly, u) {
    const { lo, hi } = segmentAt(poly, clampU(u) * poly.length);
    const a = poly.coords[lo];
    const b = poly.coords[hi];
    const dx = (b[0] - a[0]) * M_PER_DEG_LNG;
    const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
    return Math.atan2(dx, dy) * 180 / Math.PI;
}

/**
 * The closest point on the line to a coordinate.
 *
 * Exact, where the curve version sampled 2,001 points per route and took the
 * nearest — which could not resolve better than the spacing between samples,
 * about 20 m on a long route, against a 150 m match radius.
 *
 * @returns {{distance: number, u: number}} distance in meters
 */
export function nearestU(poly, lng, lat) {
    const px = lng * M_PER_DEG_LNG;
    const py = lat * M_PER_DEG_LAT;
    const metric = poly.metric;
    let bestDistance = Infinity;
    let bestU = 0;

    for (let i = 1; i < metric.length; i++) {
        const ax = metric[i - 1][0];
        const ay = metric[i - 1][1];
        const dx = metric[i][0] - ax;
        const dy = metric[i][1] - ay;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) continue;

        // Projection of the point onto the segment, clamped to its ends.
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
        const ex = ax + t * dx - px;
        const ey = ay + t * dy - py;
        // Compared as squares: order-preserving, so the nearest segment is the
        // same one either way, and it skips a square root per segment.
        const distanceSq = ex * ex + ey * ey;
        if (distanceSq < bestDistance) {
            bestDistance = distanceSq;
            bestU = (poly.cumulative[i - 1] + t * Math.sqrt(lengthSq)) / poly.length;
        }
    }

    return { distance: Math.sqrt(bestDistance), u: bestU };
}

/**
 * The line's extent, grown by a margin in meters.
 *
 * Exists so a caller testing many points against a line can reject most of them
 * before measuring anything. The margin is the caller's match radius, which is
 * what makes the rejection exact rather than approximate: a point outside these
 * bounds is further than the margin from every segment, so its true distance
 * would have been discarded anyway.
 */
export function boundsOf(poly, marginMeters = 0) {
    const dLat = marginMeters / M_PER_DEG_LAT;
    const dLng = marginMeters / M_PER_DEG_LNG;

    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of poly.coords) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    }

    return {
        minLng: minLng - dLng, maxLng: maxLng + dLng,
        minLat: minLat - dLat, maxLat: maxLat + dLat,
    };
}

/** Whether a coordinate falls inside bounds from boundsOf. */
export function withinBounds(bounds, lng, lat) {
    return lng >= bounds.minLng && lng <= bounds.maxLng
        && lat >= bounds.minLat && lat <= bounds.maxLat;
}
