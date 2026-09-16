import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    parsePlatforms, indexByComplex, levelsOf, depthForLevel, METERS_PER_LEVEL,
} from '../../src/core/platforms.js';

const row = (over = {}) => ({
    c: '611', l: -2,
    g: [[40.7560, -73.9870], [40.7562, -73.9868], [40.7561, -73.9865]],
    ...over,
});

describe('parsePlatforms', () => {
    it('reshapes a row into something drawable', () => {
        expect(parsePlatforms([row()])[0]).toEqual({
            complexId: '611', level: -2,
            ring: [[40.7560, -73.9870], [40.7562, -73.9868], [40.7561, -73.9865]],
        });
    });

    it('keeps a platform with no level rather than assuming street', () => {
        // A missing level is unknown, not zero. Treating it as street would
        // stack it above a mezzanine it may sit below.
        expect(parsePlatforms([row({ l: null })])[0].level).toBeNull();
        expect(parsePlatforms([row({ l: undefined })])[0].level).toBeNull();
    });

    it('drops rings too short to enclose anything', () => {
        // A platform mapped as a line rather than an area cannot be a footprint.
        expect(parsePlatforms([row({ g: [[40.7, -74], [40.71, -74]] })])).toEqual([]);
        expect(parsePlatforms([row({ g: [] })])).toEqual([]);
    });

    it('drops rows with no complex', () => {
        expect(parsePlatforms([row({ c: undefined })])).toEqual([]);
    });

    it('survives missing input', () => {
        expect(parsePlatforms(null)).toEqual([]);
        expect(parsePlatforms([null, undefined])).toEqual([]);
    });
});

describe('indexByComplex', () => {
    it('groups platforms by their complex', () => {
        const idx = indexByComplex(parsePlatforms([row(), row(), row({ c: '628' })]));
        expect(idx.get('611')).toHaveLength(2);
        expect(idx.get('628')).toHaveLength(1);
        expect(idx.get('nope')).toBeUndefined();
    });

    it('survives missing input', () => {
        expect(indexByComplex(null).size).toBe(0);
    });
});

describe('levelsOf', () => {
    it('lists the distinct levels a complex spans, deepest first', () => {
        const platforms = parsePlatforms([row({ l: -1 }), row({ l: -4 }), row({ l: -2 }), row({ l: -2 })]);
        expect(levelsOf(platforms)).toEqual([-4, -2, -1]);
    });

    it('ignores platforms with no level', () => {
        expect(levelsOf(parsePlatforms([row({ l: null }), row({ l: -1 })]))).toEqual([-1]);
    });
});

describe('depthForLevel', () => {
    it('maps a storey index to meters, negative underground', () => {
        expect(depthForLevel(-2)).toBe(-2 * METERS_PER_LEVEL);
        expect(depthForLevel(0)).toBe(0);
        // Elevated track is the part the feed gets right: Smith-9 Sts at level 4
        // genuinely is the highest station in the system.
        expect(depthForLevel(4)).toBe(4 * METERS_PER_LEVEL);
    });

    it('treats an unknown level as street rather than as NaN', () => {
        expect(depthForLevel(null)).toBe(0);
        expect(depthForLevel(undefined)).toBe(0);
        expect(depthForLevel('deep')).toBe(0);
    });
});

// ── the shipped asset ───────────────────────────────────────────────────────
// public/platforms.json is a build input like public/gtfs, so it may be absent
// on a fresh checkout and in CI. These run only when it is there.
const asset = (() => {
    try {
        return JSON.parse(readFileSync(new URL('../../public/platforms.json', import.meta.url), 'utf8'));
    } catch {
        return null;
    }
})();

describe.skipIf(!asset)('the shipped asset', () => {
    it('covers the system', () => {
        const idx = indexByComplex(parsePlatforms(asset));
        expect(idx.size).toBeGreaterThanOrEqual(400);
    });

    it('carries a level for the large majority of platforms', () => {
        const parsed = parsePlatforms(asset);
        const levelled = parsed.filter(p => p.level !== null).length;
        expect(levelled / parsed.length).toBeGreaterThan(0.9);
    });

    it('resolves Times Sq to several platforms across several levels', () => {
        const idx = indexByComplex(parsePlatforms(asset));
        const times = idx.get('611') ?? [];
        expect(times.length).toBeGreaterThan(3);
        expect(levelsOf(times).length).toBeGreaterThan(1);
    });

    it('holds rings that can be drawn, not lines', () => {
        for (const p of parsePlatforms(asset)) {
            expect(p.ring.length).toBeGreaterThanOrEqual(3);
        }
    });
});
