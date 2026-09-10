import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    parseEntrances, indexByComplex, normalizeType, entranceLabel, ENTRANCE_TYPES,
} from '../../src/core/entrances.js';

const row = (over = {}) => ({ c: '611', y: 40.7549, x: -73.9840, t: 'Stair', i: 1, o: 1, ...over });

describe('normalizeType', () => {
    it('collapses the stair variants, which a rider treats the same', () => {
        expect(normalizeType('Stair')).toBe('stair');
        expect(normalizeType('Stair/Escalator')).toBe('stair');
        expect(normalizeType('Stair/Ramp')).toBe('stair');
        expect(normalizeType('Stair/Ramp/Walkway')).toBe('stair');
    });

    it('keeps the distinctions that change what a rider does', () => {
        expect(normalizeType('Elevator')).toBe('elevator');
        expect(normalizeType('Escalator')).toBe('escalator');
        expect(normalizeType('Ramp')).toBe('ramp');
    });

    it('groups the passage-like types together', () => {
        for (const t of ['Easement - Passage', 'Underpass', 'Walkway', 'Overpass']) {
            expect(normalizeType(t)).toBe('passage');
        }
    });

    it('draws an unknown type rather than dropping it', () => {
        expect(normalizeType('Teleporter')).toBe('stair');
        expect(normalizeType(undefined)).toBe('stair');
    });

    it('only ever produces a type the layer knows how to draw', () => {
        const sources = ['Stair', 'Elevator', 'Escalator', 'Ramp', 'Station House',
            'Easement - Street', 'Easement - Passage', 'Underpass', 'Walkway',
            'Overpass', 'Stair/Escalator', 'Stair/Ramp', 'Stair/Ramp/Walkway', 'Nonsense'];
        for (const s of sources) expect(ENTRANCE_TYPES).toContain(normalizeType(s));
    });
});

describe('parseEntrances', () => {
    it('reshapes a row into something the map can place', () => {
        expect(parseEntrances([row()])[0]).toEqual({
            complexId: '611', lat: 40.7549, lng: -73.9840,
            type: 'stair', entry: true, exit: true,
        });
    });

    it('reads the entry and exit flags', () => {
        expect(parseEntrances([row({ i: 0 })])[0].entry).toBe(false);
        expect(parseEntrances([row({ o: 0 })])[0].exit).toBe(false);
    });

    it('assumes an unmarked entrance is usable both ways', () => {
        // Marking a working entrance "exit only" sends someone the long way
        // round, which is the more expensive mistake of the two.
        const parsed = parseEntrances([{ c: '611', y: 40.75, x: -73.98 }])[0];
        expect(parsed.entry).toBe(true);
        expect(parsed.exit).toBe(true);
    });

    it('drops rows it cannot put on a map', () => {
        expect(parseEntrances([row({ y: undefined })])).toEqual([]);
        expect(parseEntrances([row({ x: 'not a number' })])).toEqual([]);
        expect(parseEntrances([row({ c: undefined })])).toEqual([]);
    });

    it('survives missing input', () => {
        expect(parseEntrances(null)).toEqual([]);
        expect(parseEntrances(undefined)).toEqual([]);
        expect(parseEntrances([null, undefined])).toEqual([]);
    });
});

describe('indexByComplex', () => {
    it('groups entrances under the complex they serve', () => {
        const index = indexByComplex(parseEntrances([
            row({ c: '611' }), row({ c: '611' }), row({ c: '617' }),
        ]));
        expect(index.get('611')).toHaveLength(2);
        expect(index.get('617')).toHaveLength(1);
        expect(index.get('999')).toBeUndefined();
    });

    it('survives missing input', () => {
        expect(indexByComplex(null).size).toBe(0);
    });
});

describe('entranceLabel', () => {
    it('says nothing about an ordinary stair', () => {
        // 1,629 of 2,120 entrances are plain stairs. Labelling them would bury
        // the hundred or so that carry information.
        expect(entranceLabel({ type: 'stair', entry: true, exit: true })).toBeNull();
        expect(entranceLabel({ type: 'street', entry: true, exit: true })).toBeNull();
    });

    it('names elevators and escalators', () => {
        expect(entranceLabel({ type: 'elevator', entry: true, exit: true })).toBe('Elevator');
        expect(entranceLabel({ type: 'escalator', entry: true, exit: true })).toBe('Escalator');
    });

    it('warns about exit-only before naming the type', () => {
        // Walking to a stair you cannot enter costs more than not knowing it
        // was an escalator.
        expect(entranceLabel({ type: 'escalator', entry: false, exit: true })).toBe('Exit only');
        expect(entranceLabel({ type: 'stair', entry: false, exit: true })).toBe('Exit only');
    });

    it('survives missing input', () => {
        expect(entranceLabel(null)).toBeNull();
    });
});

// ── the real dataset ────────────────────────────────────────────────────────
// public/entrances.json is a build input like public/gtfs, so it may not exist
// on a fresh checkout or in CI. These assertions run only when it does — the
// mechanics above are covered either way.
const raw = (() => {
    try {
        return JSON.parse(readFileSync(new URL('../../public/entrances.json', import.meta.url), 'utf8'));
    } catch {
        return null;
    }
})();

describe.skipIf(!raw)('the real dataset', () => {
    it('places every entrance', () => {
        expect(parseEntrances(raw)).toHaveLength(raw.length);
        expect(raw.length).toBeGreaterThanOrEqual(2000);
    });

    it('covers every complex, which is why the join is on complex_id', () => {
        // Joining on gtfs_stop_id instead reaches 485 of 496 stations, because
        // three rows carry a compound id like "A32; D20".
        expect(indexByComplex(parseEntrances(raw)).size).toBe(445);
    });

    it('labels only the entrances that tell a rider something', () => {
        const parsed = parseEntrances(raw);
        const labelled = parsed.filter(entranceLabel);
        expect(labelled.length).toBeGreaterThan(100);
        expect(labelled.length).toBeLessThan(parsed.length / 5);
    });

    it('normalizes every source type it actually encounters', () => {
        for (const t of new Set(raw.map(r => r.t))) {
            expect(ENTRANCE_TYPES).toContain(normalizeType(t));
        }
    });
});
