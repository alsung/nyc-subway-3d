import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    buildCorridors, offsetPoints, segmentCoords,
    CORRIDOR_RADIUS_M, MIN_RUN_M,
} from '../../src/core/corridors.js';
import { trunkOf } from '../../src/core/trunks.js';

// ── synthetic fixtures ──────────────────────────────────────────────────────
// Straight lines built in degrees so the projection is exercised for real
// rather than stubbed. At NYC's latitude one degree of latitude is 111,320 m
// and one of longitude about 84,400 m.
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos(40.73 * Math.PI / 180);

const BASE_LAT = 40.75;
const BASE_LNG = -73.98;

/** n points from (lat, lng), stepping by (dLat, dLng) each time. */
const line = (lat, lng, dLat, dLng, n) =>
    Array.from({ length: n }, (_, i) => [lat + dLat * i, lng + dLng * i]);

/** A 300 m north-to-south line, `metersEast` east of BASE_LNG, in n points. */
const southbound = (metersEast, n = 60) =>
    line(BASE_LAT, BASE_LNG + metersEast / M_PER_DEG_LNG, -300 / M_PER_DEG_LAT / n, 0, n);

/** A route made of one polyline — the shape buildCorridors takes. */
const one = (coords) => [coords];

/** The segments of a route's first (here, only) polyline. */
const segs = (corridors, routeId) => corridors.get(routeId)[0];

/** Same track, digitized the other way. */
const reversed = (coords) => [...coords].reverse();

const meanLng = (coords) => coords.reduce((a, c) => a + c[1], 0) / coords.length;

describe('buildCorridors — a route on its own', () => {
    it('emits one segment at rank 0 covering every point', () => {
        const coords = southbound(0);
        const c = buildCorridors({ A: one(coords) });
        const segList = segs(c, 'A');

        expect(segList).toHaveLength(1);
        expect(segList[0]).toMatchObject({ from: 0, to: coords.length - 1, rank: 0, flip: false });
        expect(segList[0].trunks).toEqual(['ACE']);
    });

    it('skips routes with fewer than two points', () => {
        const c = buildCorridors({ A: one([[BASE_LAT, BASE_LNG]]), N: one(southbound(0)) });
        expect(c.has('A')).toBe(false);
        expect(c.has('N')).toBe(true);
    });

    it('returns an empty map for missing or empty input', () => {
        expect(buildCorridors(null).size).toBe(0);
        expect(buildCorridors({}).size).toBe(0);
    });
});

describe('buildCorridors — two trunks sharing a right-of-way', () => {
    it('centres their ranks on zero so the ribbon straddles the alignment', () => {
        const c = buildCorridors({ A: one(southbound(0)), N: one(southbound(20)) });

        expect(segs(c, 'A')[0].rank).toBe(-0.5);
        expect(segs(c, 'N')[0].rank).toBe(0.5);
        expect(segs(c, 'A')[0].trunks).toEqual(['ACE', 'NQRW']);
    });

    it('orders strands by the trunk table, so the same pair never crosses', () => {
        const near = buildCorridors({ A: one(southbound(0)), N: one(southbound(20)) });
        const swapped = buildCorridors({ A: one(southbound(20)), N: one(southbound(0)) });

        // Geometry swapped, ranks did not: ACE sorts before NQRW either way.
        expect(segs(near, 'A')[0].rank).toBe(segs(swapped, 'A')[0].rank);
        expect(segs(near, 'N')[0].rank).toBe(segs(swapped, 'N')[0].rank);
    });

    it('gives three trunks ranks of -1, 0 and 1', () => {
        const c = buildCorridors({ A: one(southbound(0)), N: one(southbound(20)), 1: one(southbound(40)) });
        // Table order is ACE, NQRW, 123.
        expect(segs(c, 'A')[0].rank).toBe(-1);
        expect(segs(c, 'N')[0].rank).toBe(0);
        expect(segs(c, '1')[0].rank).toBe(1);
    });

    it('gives routes in the same trunk the same rank, so they draw as one strand', () => {
        const c = buildCorridors({ 4: one(southbound(0)), 5: one(southbound(15)), A: one(southbound(35)) });
        expect(segs(c, '4')[0].rank).toBe(segs(c, '5')[0].rank);
        expect(segs(c, '4')[0].trunks).toEqual(['ACE', '456']);
    });
});

describe('buildCorridors — direction', () => {
    it('marks a segment that runs against its canonical trunk', () => {
        const c = buildCorridors({ A: one(southbound(0)), N: one(reversed(southbound(20))) });
        expect(segs(c, 'A')[0].flip).toBe(false);
        expect(segs(c, 'N')[0].flip).toBe(true);
    });

    it('pushes opposite-digitized strands apart instead of onto each other', () => {
        // The whole reason flip exists, and the realistic case: two routes on a
        // shared corridor have near-identical shapes, so the ribbon is built
        // entirely by the offsets. Here they are exactly coincident.
        const a = southbound(0);
        const n = reversed(southbound(0));
        const c = buildCorridors({ A: one(a), N: one(n) });

        const gap = Math.abs(
            meanLng(offsetPoints(n, segs(c, 'N'), 12)) - meanLng(offsetPoints(a, segs(c, 'A'), 12)),
        ) * M_PER_DEG_LNG;
        expect(gap).toBeCloseTo(12, 0);
    });

    it('would stack them on top of each other if flip were ignored', () => {
        // The control for the test above: same ranks, flip forced off, and the
        // two strands land in the same place. Without this the assertion above
        // would still pass if offsetPoints stopped honoring flip at all.
        const a = southbound(0);
        const n = reversed(southbound(0));
        const c = buildCorridors({ A: one(a), N: one(n) });
        const ignoreFlip = (segs) => segs.map(s => ({ ...s, flip: false }));

        const gap = Math.abs(
            meanLng(offsetPoints(n, ignoreFlip(segs(c, 'N')), 12))
            - meanLng(offsetPoints(a, ignoreFlip(segs(c, 'A')), 12)),
        ) * M_PER_DEG_LNG;
        expect(gap).toBeCloseTo(0, 0);
    });
});

describe('buildCorridors — crossings versus corridors', () => {
    it('ignores a brief overlap rather than splitting a segment for it', () => {
        // A perpendicular line clipping the corridor for a couple of points.
        const a = southbound(0, 60);
        const crossLat = a[30][0];
        const n = line(crossLat, BASE_LNG - 300 / M_PER_DEG_LNG, 0, 10 / M_PER_DEG_LNG, 60);

        const c = buildCorridors({ A: one(a), N: one(n) });
        expect(segs(c, 'A')).toHaveLength(1);
        expect(segs(c, 'A')[0].rank).toBe(0);
    });

    it('keeps the crossing as its own segment when the threshold is removed', () => {
        // Proves the merge is what suppresses it, not the detector missing it.
        const a = southbound(0, 60);
        const crossLat = a[30][0];
        const n = line(crossLat, BASE_LNG - 300 / M_PER_DEG_LNG, 0, 10 / M_PER_DEG_LNG, 60);

        const c = buildCorridors({ A: one(a), N: one(n) }, { minRunM: 0 });
        expect(segs(c, 'A').length).toBeGreaterThan(1);
    });

    it('measures the threshold in meters, not in shape points', () => {
        // The same crossing sampled twice as densely must still be suppressed.
        // A point-count threshold would keep one and drop the other.
        const sparse = southbound(0, 30);
        const dense = southbound(0, 120);
        const crossing = (a) => line(a[Math.floor(a.length / 2)][0],
            BASE_LNG - 300 / M_PER_DEG_LNG, 0, 10 / M_PER_DEG_LNG, 60);

        expect(segs(buildCorridors({ A: one(sparse), N: one(crossing(sparse)) }), 'A')).toHaveLength(1);
        expect(segs(buildCorridors({ A: one(dense), N: one(crossing(dense)) }), 'A')).toHaveLength(1);
    });
});

describe('segmentCoords', () => {
    const coords = southbound(0, 10);

    it('reverses only when the segment is flipped', () => {
        const plain = segmentCoords(coords, { from: 0, to: 4, flip: false });
        const flipped = segmentCoords(coords, { from: 0, to: 4, flip: true });
        expect(plain[0]).toEqual(coords[0]);
        expect(flipped[0]).toEqual(coords[4]);
    });

    it('overlaps the previous segment by one point so strands meet', () => {
        const second = segmentCoords(coords, { from: 5, to: 9, flip: false });
        expect(second[0]).toEqual(coords[4]);
        expect(second).toHaveLength(6);
    });

    it('does not run off the start of the array', () => {
        expect(segmentCoords(coords, { from: 0, to: 2, flip: false })).toHaveLength(3);
    });
});

describe('offsetPoints', () => {
    const coords = southbound(0, 40);

    it('leaves a rank-0 route exactly where it was', () => {
        const segs = [{ from: 0, to: 39, rank: 0, flip: false }];
        expect(offsetPoints(coords, segs, 12)).toEqual(coords);
    });

    it('returns the input when there is nothing to offset', () => {
        expect(offsetPoints(coords, [], 12)).toBe(coords);
        expect(offsetPoints(coords, [{ from: 0, to: 39, rank: 1, flip: false }], 0)).toBe(coords);
    });

    it('displaces perpendicular to travel, by rank times the spacing', () => {
        const segs = [{ from: 0, to: 39, rank: 1, flip: false }];
        const moved = offsetPoints(coords, segs, 12);

        // A north-south line displaces east or west only.
        const dLat = Math.abs(moved[20][0] - coords[20][0]) * M_PER_DEG_LAT;
        const dLng = Math.abs(moved[20][1] - coords[20][1]) * M_PER_DEG_LNG;
        expect(dLat).toBeLessThan(0.5);
        expect(dLng).toBeCloseTo(12, 0);
    });

    it('scales with rank and mirrors across zero', () => {
        const pos = offsetPoints(coords, [{ from: 0, to: 39, rank: 1.5, flip: false }], 12);
        const neg = offsetPoints(coords, [{ from: 0, to: 39, rank: -1.5, flip: false }], 12);
        const spread = (pos[20][1] - coords[20][1]) * M_PER_DEG_LNG;
        expect(Math.abs(spread)).toBeCloseTo(18, 0);
        expect((neg[20][1] - coords[20][1]) * M_PER_DEG_LNG).toBeCloseTo(-spread, 0);
    });
});

describe('trunkOf', () => {
    it('maps every express variant to its parent trunk', () => {
        expect(trunkOf('FX')).toBe(trunkOf('F'));
        expect(trunkOf('6X')).toBe(trunkOf('6'));
        expect(trunkOf('7X')).toBe(trunkOf('7'));
    });

    it('returns null rather than guessing for an unknown route', () => {
        expect(trunkOf('QQ')).toBeNull();
        expect(trunkOf(undefined)).toBeNull();
    });
});

// ── the real system ─────────────────────────────────────────────────────────
// Regression tests against actual geometry: the synthetic cases prove the
// mechanics, these prove it produces the right answer for corridors a New
// Yorker would recognize.
//
// Read from a committed fixture rather than public/gtfs, which is a build input
// and is not in the repo — CI's test job never downloads it. The fixture is the
// real feed thinned to one point every 60 m by
// scripts/build-corridor-fixture.mjs; corridors are kilometers long, so every
// one of them survives that.
const feed = (() => {
    const lineRoutes = JSON.parse(
        readFileSync(new URL('../fixtures/line-routes.json', import.meta.url), 'utf8'),
    );
    return { lineRoutes, corridors: buildCorridors(lineRoutes) };
})();

/** The longest segment of `routeId` whose membership is exactly `trunks`. */
const longestWith = (routeId, trunks) =>
    feed.corridors.get(routeId).flat()
        .filter(s => s.trunks.length === trunks.length && trunks.every(t => s.trunks.includes(t)))
        .sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];

describe('the real feed', () => {
    it('finds Queens Boulevard and stacks E, F/M and R in trunk order', () => {
        const qb = ['ACE', 'BDFM', 'NQRW'];
        const rank = (id) => longestWith(id, qb)?.rank;

        expect(rank('E')).toBe(-1);
        expect(rank('F')).toBe(0);
        expect(rank('M')).toBe(0);   // F and M share a strand — both orange
        expect(rank('R')).toBe(1);
    });

    it('draws 4, 5 and 6 as one strand wherever they run together', () => {
        const lex = ['456'];
        for (const id of ['4', '5', '6']) {
            expect(longestWith(id, lex)?.rank).toBe(0);
        }
    });

    it('never lets two trunks cross', () => {
        // The invariant the global order buys: if trunk X sits left of Y in one
        // corridor it sits left of Y in every corridor. A violation would show
        // as strands swapping sides mid-system.
        const side = new Map();
        for (const [routeId, perPolyline] of feed.corridors) {
            const own = trunkOf(routeId) ?? 'Other';
            for (const seg of perPolyline.flat()) {
                for (const other of seg.trunks) {
                    if (other === own) continue;
                    const sign = Math.sign(seg.rank - (seg.trunks.indexOf(other) - (seg.trunks.length - 1) / 2));
                    const key = `${own}|${other}`;
                    if (side.has(key)) expect(side.get(key)).toBe(sign);
                    else side.set(key, sign);
                }
            }
        }
        expect(side.size).toBeGreaterThan(0);
    });

    it('tiles every route with contiguous segments and no gaps', () => {
        for (const [routeId, perPolyline] of feed.corridors) {
            perPolyline.forEach((segList, i) => {
                expect(segList[0].from).toBe(0);
                expect(segList[segList.length - 1].to).toBe(feed.lineRoutes[routeId][i].length - 1);
                for (let k = 1; k < segList.length; k++) {
                    expect(segList[k].from).toBe(segList[k - 1].to + 1);
                }
            });
        }
    });

    it('covers all 29 routes', () => {
        expect(feed.corridors.size).toBe(29);
    });

    it('stays well inside the startup budget', () => {
        // The bound is deliberately loose because CI machines are not this one;
        // it exists to catch an accidental O(n^2), not to police milliseconds.
        // The real feed is ~5x this fixture and measures 9.2 ms locally.
        const t0 = performance.now();
        buildCorridors(feed.lineRoutes);
        expect(performance.now() - t0).toBeLessThan(250);
    });
});

describe('exported tuning constants', () => {
    it('keeps the corridor radius wide enough for a four-track trunk', () => {
        expect(CORRIDOR_RADIUS_M).toBeGreaterThanOrEqual(40);
        // Must clear the ~2 x radius of shared run that a plain crossing makes.
        expect(MIN_RUN_M).toBeGreaterThan(CORRIDOR_RADIUS_M * 2);
    });
});
