import { describe, it, expect } from 'vitest';
import { preparePolyline, pointAt, bearingAt, nearestU } from '../../src/core/polyline.js';

// Fixtures are built in degrees but asserted in meters, which is the unit every
// caller reasons in — station match radii, distance travelled between stops.
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos(40.73 * Math.PI / 180);

// A line running due north from the origin, of the given length in meters.
const northLine = (meters, steps = 2) => preparePolyline(
    Array.from({ length: steps + 1 }, (_, i) => [0, (i / steps) * meters / M_PER_DEG_LAT]),
);

describe('preparePolyline', () => {
    it('measures length in meters', () => {
        expect(northLine(1000).length).toBeCloseTo(1000, 1);
    });

    it('rejects anything that is not a line', () => {
        expect(preparePolyline([[0, 0]])).toBeNull();
        expect(preparePolyline([])).toBeNull();
        expect(preparePolyline(null)).toBeNull();
        // Repeated identical points measure zero and would divide by zero.
        expect(preparePolyline([[0, 0], [0, 0], [0, 0]])).toBeNull();
    });
});

describe('pointAt', () => {
    it('is parameterized by distance, not by vertex index', () => {
        // Vertices deliberately bunched at the start: one in the first 100 m,
        // then a 900 m run. A vertex-indexed parameter would put u=0.5 at the
        // 100 m mark; arc length puts it at 500 m.
        const poly = preparePolyline([
            [0, 0],
            [0, 100 / M_PER_DEG_LAT],
            [0, 1000 / M_PER_DEG_LAT],
        ]);
        const mid = pointAt(poly, 0.5);
        expect(mid.lat * M_PER_DEG_LAT).toBeCloseTo(500, 0);
    });

    it('clamps outside [0, 1] rather than extrapolating off the line', () => {
        const poly = northLine(1000);
        expect(pointAt(poly, -3).lat).toBeCloseTo(0, 9);
        expect(pointAt(poly, 42).lat * M_PER_DEG_LAT).toBeCloseTo(1000, 0);
        // A train whose interpolation overshoots must stop at the end of its
        // line, not fly past the last station.
        expect(pointAt(poly, NaN).lat).toBeCloseTo(0, 9);
    });
});

describe('bearingAt', () => {
    it('reads degrees clockwise from north', () => {
        expect(bearingAt(northLine(1000), 0.5)).toBeCloseTo(0, 6);

        const east = preparePolyline([[0, 0], [1000 / M_PER_DEG_LNG, 0]]);
        expect(bearingAt(east, 0.5)).toBeCloseTo(90, 6);

        const south = preparePolyline([[0, 0], [0, -1000 / M_PER_DEG_LAT]]);
        expect(Math.abs(bearingAt(south, 0.5))).toBeCloseTo(180, 6);
    });

    it('follows the segment the point actually sits on', () => {
        // North for 1 km, then east for 1 km.
        const bent = preparePolyline([
            [0, 0],
            [0, 1000 / M_PER_DEG_LAT],
            [1000 / M_PER_DEG_LNG, 1000 / M_PER_DEG_LAT],
        ]);
        expect(bearingAt(bent, 0.25)).toBeCloseTo(0, 6);
        expect(bearingAt(bent, 0.75)).toBeCloseTo(90, 6);
    });
});

describe('nearestU', () => {
    it('finds the perpendicular foot, not the nearest vertex', () => {
        // Two vertices 1 km apart; the query sits beside the midpoint. A
        // nearest-vertex search would answer u = 0 or u = 1.
        const poly = northLine(1000, 1);
        const { distance, u } = nearestU(poly, 30 / M_PER_DEG_LNG, 500 / M_PER_DEG_LAT);

        expect(u).toBeCloseTo(0.5, 3);
        expect(distance).toBeCloseTo(30, 0);
    });

    it('clamps to the ends for a point beyond the line', () => {
        const poly = northLine(1000, 1);
        const past = nearestU(poly, 0, 1500 / M_PER_DEG_LAT);

        expect(past.u).toBeCloseTo(1, 6);
        expect(past.distance).toBeCloseTo(500, 0);
    });

    it('resolves finer than the old sampled search could', () => {
        // buildStationTByRoute sampled 2,001 points per curve, so on a 40 km
        // route it could not place a station better than ~20 m along the line.
        // This is exact, so a 1 m offset resolves as 1 m.
        const poly = northLine(40_000, 4);
        const { u } = nearestU(poly, 0, 10_001 / M_PER_DEG_LAT);
        expect(u * poly.length).toBeCloseTo(10_001, 0);
    });
});
