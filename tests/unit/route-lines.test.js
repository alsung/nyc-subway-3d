import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { routeLineFeatures } from '../../src/scene/renderer.js';
import { buildCorridors } from '../../src/core/corridors.js';

// renderer.js also builds a Maplibre map and a Three.js scene, but neither runs
// at import time, so the pure half is testable without a canvas.

const lineRoutes = JSON.parse(
    readFileSync(new URL('../fixtures/line-routes.json', import.meta.url), 'utf8'),
);
const corridors = buildCorridors(lineRoutes);
const routeMap = Object.fromEntries(Object.keys(lineRoutes).map(id => [id, { color: '#111111' }]));

describe('routeLineFeatures', () => {
    it('draws every polyline of a branching route', () => {
        // The A has Rockaway and Lefferts; before the cover it had one line and
        // those branches were simply absent from the map.
        expect(lineRoutes.A.length).toBeGreaterThan(1);
        const fc = routeLineFeatures({ A: lineRoutes.A }, corridors, routeMap);
        const segments = corridors.get('A').reduce((a, l) => a + l.length, 0);
        expect(fc.features).toHaveLength(segments);
    });

    it('emits one feature per corridor segment, not per route', () => {
        const fc = routeLineFeatures(lineRoutes, corridors, routeMap);
        let segments = 0;
        for (const perPolyline of corridors.values()) {
            for (const segList of perPolyline) segments += segList.length;
        }

        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(segments);
        expect(fc.features.length).toBeGreaterThan(Object.keys(lineRoutes).length);
    });

    it('gives every feature a numeric rank', () => {
        const fc = routeLineFeatures(lineRoutes, corridors, routeMap);
        for (const f of fc.features) {
            expect(Number.isFinite(f.properties.rank)).toBe(true);
        }
        // Some strands are off-center or the ribbon does not exist.
        expect(fc.features.some(f => f.properties.rank !== 0)).toBe(true);
    });

    it('carries the rank of the segment it came from', () => {
        const fc = routeLineFeatures({ M: lineRoutes.M }, corridors, routeMap);
        expect(fc.features.map(f => f.properties.rank))
            .toEqual(corridors.get('M').flat().map(s => s.rank));
    });

    it('writes GeoJSON lng/lat, not the lat/lng lineRoutes stores', () => {
        const fc = routeLineFeatures({ '1': lineRoutes['1'] }, corridors, routeMap);
        const [lng, lat] = fc.features[0].geometry.coordinates[0];
        expect(lng).toBeLessThan(-70);    // NYC longitude
        expect(lat).toBeGreaterThan(40);  // NYC latitude
    });

    it('reverses a flipped segment so positive ranks stay on one side', () => {
        // Features are emitted polyline by polyline, then segment by segment
        // within each, so the flat position of a segment is its feature index.
        let found = null;
        outer: for (const [routeId, perPolyline] of corridors) {
            let featureIndex = 0;
            for (let i = 0; i < perPolyline.length; i++) {
                for (const segment of perPolyline[i]) {
                    if (segment.flip) { found = { routeId, polyline: i, segment, featureIndex }; break outer; }
                    featureIndex++;
                }
            }
        }
        expect(found).not.toBeNull();

        const fc = routeLineFeatures({ [found.routeId]: lineRoutes[found.routeId] }, corridors, routeMap);
        const first = fc.features[found.featureIndex].geometry.coordinates[0];
        const [lat, lng] = lineRoutes[found.routeId][found.polyline][found.segment.to];

        expect(first).toEqual([lng, lat]);
    });

    it('keeps each route color and falls back to the MTA gray', () => {
        const fc = routeLineFeatures({ A: lineRoutes.A }, corridors, { A: { color: '#0039A6' } });
        expect(fc.features[0].properties.color).toBe('#0039A6');

        const missing = routeLineFeatures({ A: lineRoutes.A }, corridors, {});
        expect(missing.features[0].properties.color).toBe('#808183');
    });

    it('still draws a route the corridor index does not know', () => {
        // A missing entry should cost the line its strand, not its existence.
        const fc = routeLineFeatures({ A: lineRoutes.A }, new Map(), routeMap);
        // One feature per polyline — the A has branches — each undivided.
        expect(fc.features).toHaveLength(lineRoutes.A.length);
        for (const f of fc.features) expect(f.properties.rank).toBe(0);
        expect(fc.features[0].geometry.coordinates).toHaveLength(lineRoutes.A[0].length);
    });

    it('survives missing or degenerate input', () => {
        expect(routeLineFeatures(null, corridors, routeMap).features).toEqual([]);
        expect(routeLineFeatures({ A: [[[40.7, -74]]] }, corridors, routeMap).features).toEqual([]);
        expect(routeLineFeatures({ A: lineRoutes.A }, null, routeMap).features)
            .toHaveLength(lineRoutes.A.length);
        // A route value that is not an array of polylines at all.
        expect(routeLineFeatures({ A: null }, corridors, routeMap).features).toEqual([]);
    });

    it('shares a vertex between neighboring segments, so the ribbon has no gaps', () => {
        // segmentCoords starts a segment one point early, so consecutive
        // features meet at a common vertex instead of leaving a hairline gap
        // where the rank changes.
        const fc = routeLineFeatures({ M: lineRoutes.M }, corridors, routeMap);
        const segs = corridors.get('M').flat();
        let checked = 0;
        for (let i = 1; i < segs.length; i++) {
            if (segs[i].flip || segs[i - 1].flip) continue;   // reversed, so the shared point is at the far end
            expect(fc.features[i].geometry.coordinates[0])
                .toEqual(fc.features[i - 1].geometry.coordinates.at(-1));
            checked++;
        }
        expect(checked).toBeGreaterThan(0);
    });
});
