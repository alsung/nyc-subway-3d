import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    slugify, stationSlug, stationPath, parseStationPath,
    lineSlug, linePath, parseLinePath, lineRouteIds,
} from '../../src/core/slugs.js';
import { parseStops, parseRoutes, buildStationComplexes } from '../../src/core/gtfs-parser.js';
import { buildStationMeta, complexIdIndex } from '../../src/core/station-meta.js';

const read = (path) => readFileSync(fileURLToPath(new URL(`../../public/${path}`, import.meta.url)), 'utf8');

// The real data, so a renamed station or a new route is covered without
// anyone remembering to add a case.
const { stations } = parseStops(read('gtfs/stops.txt'));
const meta = buildStationMeta(JSON.parse(read('stations.json')));
const complexes = buildStationComplexes(stations, complexIdIndex(meta));
const routeIds = Object.keys(parseRoutes(read('gtfs/routes.txt')));

describe('slugify', () => {
    it('lowercases and dashes a station name', () => {
        expect(slugify('Times Sq-42 St')).toBe('times-sq-42-st');
        expect(slugify('Jay St-MetroTech')).toBe('jay-st-metrotech');
    });

    it('spells out "&", drops apostrophes and parentheses, trims the dashes', () => {
        expect(slugify('Court Sq-23 St (E & M)')).toBe('court-sq-23-st-e-and-m');
        expect(slugify("Prince's Bay")).toBe('princes-bay');
        expect(slugify(' - Wall St - ')).toBe('wall-st');
    });
});

describe('station paths, on the real stations', () => {
    const linked = complexes.filter(c => c.complexId);

    it('gives every station a complex id', () => {
        expect(linked).toHaveLength(complexes.length);
        expect(linked.length).toBeGreaterThan(400);
    });

    it('parses every path back to its complex', () => {
        for (const c of linked) {
            expect(parseStationPath(stationPath(c))).toBe(String(c.complexId));
        }
    });

    it('produces no duplicate slugs', () => {
        const slugs = linked.map(stationSlug);
        expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('builds the path the issue asks for', () => {
        const timesSq = linked.find(c => c.complexId === '611');
        expect(stationPath(timesSq)).toBe('/station/611-times-sq-42-st');
    });
});

describe('parseStationPath', () => {
    it('reads only the id, so a stale or missing name still resolves', () => {
        expect(parseStationPath('/station/611-old-name')).toBe('611');
        expect(parseStationPath('/station/611')).toBe('611');
        expect(parseStationPath('/station/611-times-sq-42-st/')).toBe('611');
    });

    it('rejects anything that is not a station path', () => {
        for (const path of ['/', '/station', '/station/', '/station/times-sq', '/stations/611',
            '/station/611/extra', '/line/g', '', null, undefined]) {
            expect(parseStationPath(path)).toBeNull();
        }
    });

    it('gives a group with no complex id no path', () => {
        expect(stationPath({ complexId: null, name: 'X' })).toBeNull();
    });
});

describe('line paths', () => {
    it('uses the short name, lowercased', () => {
        expect(linePath('G')).toBe('/line/g');
        expect(lineSlug('A')).toBe('a');
        expect(lineSlug('7')).toBe('7');
    });

    it('folds express patterns into their line', () => {
        expect(lineSlug('6X')).toBe('6');
        expect(lineSlug('7X')).toBe('7');
        expect(lineSlug('FX')).toBe('f');
        expect(parseLinePath('/line/6', routeIds)).toBe('6');
        expect(lineRouteIds('6', routeIds).sort()).toEqual(['6', '6X']);
    });

    it('tells the three shuttles and the SIR apart', () => {
        expect(lineSlug('GS')).toBe('s-42-st');
        expect(lineSlug('FS')).toBe('s-franklin-av');
        expect(lineSlug('H')).toBe('s-rockaway-park');
        expect(lineSlug('SI')).toBe('sir');
    });

    it('gives every route in routes.txt a slug that parses back to its line', () => {
        const slugs = new Set();
        for (const id of routeIds) {
            const expected = { FX: 'F', '6X': '6', '7X': '7' }[id] ?? id;
            expect(parseLinePath(linePath(id), routeIds)).toBe(expected);
            if (expected === id) slugs.add(lineSlug(id));
        }
        expect(slugs.size).toBe(routeIds.length - 3);
    });

    it('accepts a trailing slash and any case, and rejects the rest', () => {
        expect(parseLinePath('/line/G/', routeIds)).toBe('G');
        for (const path of ['/line/', '/line/xyz', '/line/s', '/lines/g', '/line/g/x', '/']) {
            expect(parseLinePath(path, routeIds)).toBeNull();
        }
    });
});
