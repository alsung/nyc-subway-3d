import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tripPathFeatures } from '../../src/core/trip-path.js';
import { parseGTFS } from '../../src/core/gtfs-parser.js';
import { buildCorridors } from '../../src/core/corridors.js';

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos(40.73 * Math.PI / 180);
const BASE_LAT = 40.75;
const BASE_LNG = -73.98;

// Fixtures are laid out in meters south and east of a base point.
const at = (south, east) => ({ lat: BASE_LAT - south / M_PER_DEG_LAT, lng: BASE_LNG + east / M_PER_DEG_LNG });
const southOf = ([, lat]) => (BASE_LAT - lat) * M_PER_DEG_LAT;
const eastOf = ([lng]) => (lng - BASE_LNG) * M_PER_DEG_LNG;
const metersBetween = ([lng1, lat1], [lng2, lat2]) =>
    Math.hypot((lng2 - lng1) * M_PER_DEG_LNG, (lat2 - lat1) * M_PER_DEG_LAT);
const lengthOf = (coords) => coords.slice(1).reduce((sum, c, i) => sum + metersBetween(coords[i], c), 0);

// Route A runs 1 km south to a junction, then splits: one shape branches 1 km
// west, the other 1 km east. Points every 100 m, stored [lat, lng] like
// lineRoutes.
const steps = (n, f) => Array.from({ length: n }, (_, i) => f((i + 1) * 100));
const toLatLng = ({ lat, lng }) => [lat, lng];
const trunk = [at(0, 0), ...steps(10, m => at(m, 0))].map(toLatLng);
const westBranch = [...trunk, ...steps(10, m => at(1000, -m)).map(toLatLng)];
const eastBranch = [...trunk, ...steps(10, m => at(1000, m)).map(toLatLng)];

const stations = {
    T1: at(0, 0), T2: at(500, 0), T3: at(1000, 0),
    W1: at(1000, -500), E1: at(1000, 500), E2: at(1000, 1000),
};
const stationById = new Map(Object.entries(stations).map(([id, s]) => [id, { id, ...s }]));
const routeMap = { A: { color: '#0039A6' }, F: { color: '#FF6319' } };
const lineRoutes = { A: [westBranch, eastBranch], F: [eastBranch] };

const ride = (routeId, stops) => ({ kind: 'ride', routeId, fromStop: stops[0], toStop: stops.at(-1), stops });
const walk = (fromStop, toStop) => ({ kind: 'walk', fromStop, toStop });
const features = (legs, deps = {}) =>
    tripPathFeatures({ legs }, { lineRoutes, stationById, routeMap, ...deps });
const coordsOf = (fs) => fs.flatMap(f => f.geometry.coordinates);

describe('tripPathFeatures, a ride', () => {
    it('draws only the stretch between the first and last stop', () => {
        const [f, ...rest] = features([ride('A', ['T2S', 'T3S', 'E1S'])]);

        expect(rest).toHaveLength(0);
        expect(f.properties).toEqual({ kind: 'ride', routeId: 'A', color: '#0039A6', rank: 0 });
        const coords = f.geometry.coordinates;
        expect(southOf(coords[0])).toBeCloseTo(500, 0);
        expect(eastOf(coords.at(-1))).toBeCloseTo(500, 0);
        // 500 m down the trunk and 500 m along the branch, not the whole route.
        expect(lengthOf(coords)).toBeCloseTo(1000, 0);
    });

    it('follows the branch the leg runs on', () => {
        const east = coordsOf(features([ride('A', ['T1S', 'T3S', 'E1S', 'E2S'])]));
        const west = coordsOf(features([ride('A', ['T1N', 'T3N', 'W1N'])]));

        expect(Math.min(...east.map(eastOf))).toBeGreaterThan(-1);
        expect(Math.max(...east.map(eastOf))).toBeCloseTo(1000, 0);
        expect(Math.max(...west.map(eastOf))).toBeLessThan(1);
        expect(Math.min(...west.map(eastOf))).toBeCloseTo(-500, 0);
    });

    it('splits where the route changes strand, keeping each rank and its orientation', () => {
        // The west shape's points: 0-10 down the trunk, 11-20 along the branch.
        const corridors = new Map([['A', [[
            { from: 0, to: 5, rank: 0, flip: false },
            { from: 6, to: 10, rank: 1, flip: true },
            { from: 11, to: 20, rank: -1, flip: false },
        ]]]]);
        const fs = features([ride('A', ['T1S', 'T3S', 'W1S'])], { corridors });

        expect(fs.map(f => f.properties.rank)).toEqual([0, 1, -1]);
        // A flipped strand is drawn reversed, as segmentCoords draws it, so its
        // offset falls on the same side as the route's own.
        const flipped = fs[1].geometry.coordinates;
        expect(southOf(flipped[0])).toBeGreaterThan(southOf(flipped.at(-1)));
        // The pieces meet at their shared vertex.
        expect(metersBetween(fs[0].geometry.coordinates.at(-1), flipped.at(-1))).toBeLessThan(0.01);
        expect(southOf(fs[0].geometry.coordinates[0])).toBeCloseTo(0, 0);
        expect(eastOf(fs[2].geometry.coordinates.at(-1))).toBeCloseTo(-500, 0);
    });

    it('draws an express pattern on its line\'s shape', () => {
        const [f] = features([ride('FX', ['T1S', 'E1S'])]);
        expect(f.properties).toMatchObject({ routeId: 'FX', color: '#FF6319' });
        expect(lengthOf(f.geometry.coordinates)).toBeCloseTo(1500, 0);
    });

    it('falls back to straight lines between the stops with no shape to follow', () => {
        // No shape at all for Z, and a shape for A that never reaches E2 from W1.
        const noShape = features([ride('Z', ['T1S', 'T2S', 'T3S'])]);
        const offShape = features([ride('A', ['W1S', 'E2S'])]);

        expect(noShape).toHaveLength(1);
        expect(noShape[0].properties).toMatchObject({ kind: 'ride', color: '#808183', rank: 0 });
        expect(noShape[0].geometry.coordinates).toEqual(
            ['T1', 'T2', 'T3'].map(id => [stations[id].lng, stations[id].lat]));
        expect(offShape[0].geometry.coordinates).toHaveLength(2);
    });

    it('draws nothing for a ride whose stops are unknown', () => {
        expect(features([ride('A', ['X1S', 'X2S'])])).toEqual([]);
    });
});

describe('tripPathFeatures, a walk', () => {
    it('draws nothing for a walk between two platforms of one station', () => {
        expect(features([walk('T3S', 'T3N')])).toEqual([]);
    });

    it('draws a walk between two stations as its own line', () => {
        const [f] = features([walk('T3S', 'W1N')]);
        expect(f.properties).toEqual({ kind: 'walk', rank: 0 });
        expect(f.geometry.coordinates).toEqual([[stations.T3.lng, stations.T3.lat], [stations.W1.lng, stations.W1.lat]]);
    });

    it('keeps the legs in order', () => {
        const fs = features([ride('A', ['T1S', 'T3S']), walk('T3S', 'W1N'), ride('A', ['W1N', 'T3N'])]);
        expect(fs.map(f => f.properties.kind)).toEqual(['ride', 'walk', 'ride']);
    });
});

// public/gtfs is downloaded by `npm run gtfs` and gitignored, so it is absent
// in CI. These run only when it is there.
const real = (() => {
    const read = (name) => readFileSync(fileURLToPath(new URL(`../../public/gtfs/${name}`, import.meta.url)), 'utf8');
    try {
        const { stations: all, routeMap: routes, lineRoutes: shapes } = parseGTFS(
            read('stops.txt'), read('routes.txt'), read('shapes.txt'), read('trips.txt'));
        return {
            lineRoutes: shapes,
            corridors: buildCorridors(shapes),
            stationById: new Map(all.map(s => [s.id, s])),
            routeMap: routes,
        };
    } catch {
        return null;
    }
})();

describe.skipIf(!real)('tripPathFeatures, on the real shapes', () => {
    // A leg's path stays among its own stops: every point is within 300 m of
    // the box around them. Highlighting the whole route breaks this at once.
    const staysAmong = (fs, stopIds) => {
        const pts = stopIds.map(id => real.stationById.get(id.replace(/[NS]$/, '')));
        const lngs = pts.map(p => p.lng);
        const lats = pts.map(p => p.lat);
        const pad = (m, perDeg) => m / perDeg;
        return coordsOf(fs).every(([lng, lat]) =>
            lng >= Math.min(...lngs) - pad(300, M_PER_DEG_LNG) && lng <= Math.max(...lngs) + pad(300, M_PER_DEG_LNG)
            && lat >= Math.min(...lats) - pad(300, M_PER_DEG_LAT) && lat <= Math.max(...lats) + pad(300, M_PER_DEG_LAT));
    };
    const byRoute = (fs, routeId) => fs.filter(f => f.properties.routeId === routeId);

    // Both journeys as the plan API returned them on 2026-11-05.
    it('36 Av to 72 St: the W to Lexington Av/59 St, a walk, then the Q', () => {
        const w = ['R06S', 'R08S', 'R09S', 'R11S'];
        const q = ['B08N', 'Q03N'];
        const fs = tripPathFeatures({ legs: [ride('W', w), walk('R11S', 'B08N'), ride('Q', q)] }, real);

        expect(byRoute(fs, 'W').length).toBeGreaterThan(0);
        expect(byRoute(fs, 'Q').length).toBeGreaterThan(0);
        expect(staysAmong(byRoute(fs, 'W'), w)).toBe(true);
        expect(staysAmong(byRoute(fs, 'Q'), q)).toBe(true);
        expect(fs.filter(f => f.properties.kind === 'walk')).toHaveLength(1);
    });

    it('Queensboro Plaza to Metropolitan Av: the 7, a walk at Court Sq, then the G', () => {
        const seven = ['718S', '719S'];
        const g = ['G22S', 'G24S', 'G26S', 'G28S', 'G29S'];
        const fs = tripPathFeatures({ legs: [ride('7', seven), walk('719S', 'G22S'), ride('G', g)] }, real);

        expect(staysAmong(byRoute(fs, '7'), seven)).toBe(true);
        expect(staysAmong(byRoute(fs, 'G'), g)).toBe(true);
        // Not the G's run on to Church Av, 10 km further south.
        const gLength = byRoute(fs, 'G').reduce((sum, f) => sum + lengthOf(f.geometry.coordinates), 0);
        expect(gLength).toBeGreaterThan(2000);
        expect(gLength).toBeLessThan(5000);
    });
});
