import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildStationTByRoute } from '../../src/scene/trains.js';
import { geoToLocalMeters, MAP_CENTER } from '../../src/core/geo.js';

// buildStationTByRoute works in the local metre space geoToLocalMeters produces,
// so the fixtures are built by going the other way: pick a metre offset, and
// derive the lat/lng that lands there. That keeps the tests readable in the
// units the matching radius is expressed in.
const METERS_PER_DEGREE_LAT = 111_320;
const cosLat = Math.cos(MAP_CENTER.lat * Math.PI / 180);

function stationAt(id, xMeters, yMeters) {
    return {
        id,
        lat: MAP_CENTER.lat - yMeters / METERS_PER_DEGREE_LAT,
        lng: MAP_CENTER.lng + xMeters / (METERS_PER_DEGREE_LAT * cosLat),
    };
}

// A straight line along x at a fixed y, in the same space the curve sampler uses.
function straightCurve(fromX, toX, atY = 0) {
    return new THREE.CatmullRomCurve3([
        new THREE.Vector3(fromX, atY, 0),
        new THREE.Vector3((fromX + toX) / 2, atY, 0),
        new THREE.Vector3(toX, atY, 0),
    ]);
}

// Sanity check on the fixtures themselves: a station built at (x, y) must land
// there once converted, or every assertion below is measuring the wrong thing.
describe('test fixtures', () => {
    it('place stations where they claim to be', () => {
        const { x, y } = geoToLocalMeters(...Object.values(
            (({ lat, lng }) => ({ lat, lng }))(stationAt('s', 500, -300)),
        ));
        expect(x).toBeCloseTo(500, 0);
        expect(y).toBeCloseTo(-300, 0);
    });
});

describe('buildStationTByRoute', () => {
    const curves = new Map([['A', straightCurve(-5000, 5000)]]);

    it('matches a station sitting on the curve', () => {
        const out = buildStationTByRoute(curves, [stationAt('on', 0, 0)]);
        expect(out.get('A').has('on')).toBe(true);
        // Mid-curve, so t is near the middle of the parameter range.
        expect(out.get('A').get('on')).toBeCloseTo(0.5, 1);
    });

    it('reports t increasing along the curve', () => {
        const out = buildStationTByRoute(curves, [
            stationAt('early', -4000, 0), stationAt('mid', 0, 0), stationAt('late', 4000, 0),
        ]);
        const t = out.get('A');
        expect(t.get('early')).toBeLessThan(t.get('mid'));
        expect(t.get('mid')).toBeLessThan(t.get('late'));
    });

    // The radius is the whole contract: it decides whether a station is "on"
    // a route at all, and every optimisation has to preserve it exactly.
    it('includes a station just inside the 150m match radius', () => {
        const out = buildStationTByRoute(curves, [stationAt('near', 0, 140)]);
        expect(out.get('A').has('near')).toBe(true);
    });

    it('excludes a station just outside it', () => {
        const out = buildStationTByRoute(curves, [stationAt('far', 0, 160)]);
        expect(out.get('A').has('far')).toBe(false);
    });

    it('excludes a station far from every curve', () => {
        const out = buildStationTByRoute(curves, [stationAt('elsewhere', 0, 9000)]);
        expect(out.get('A').size).toBe(0);
    });

    it('excludes a station beyond the end of the curve', () => {
        const out = buildStationTByRoute(curves, [stationAt('past-end', 9000, 0)]);
        expect(out.get('A').has('past-end')).toBe(false);
    });

    it('lists a station on two routes in both', () => {
        const two = new Map([
            ['A', straightCurve(-5000, 5000, 0)],
            ['B', straightCurve(-5000, 5000, 100)],   // 100m away, inside the radius
        ]);
        const out = buildStationTByRoute(two, [stationAt('shared', 0, 50)]);
        expect(out.get('A').has('shared')).toBe(true);
        expect(out.get('B').has('shared')).toBe(true);
    });

    it('returns an entry for every route, even one with no stations', () => {
        const out = buildStationTByRoute(curves, [stationAt('elsewhere', 0, 9000)]);
        expect(out.has('A')).toBe(true);
        expect(out.get('A').size).toBe(0);
    });

    it('handles empty inputs', () => {
        expect(buildStationTByRoute(new Map(), []).size).toBe(0);
        expect(buildStationTByRoute(curves, []).get('A').size).toBe(0);
    });
});
