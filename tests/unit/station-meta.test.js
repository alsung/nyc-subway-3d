import { describe, it, expect } from 'vitest';
import {
    buildStationMeta, stopIdForTrunk, routeLabelsFor, directionLabel, isLastStop, boroughName,
} from '../../src/core/station-meta.js';

// Rows shaped exactly like public/stations.json, using real values from the
// live dataset so the tests fail if MTA changes the vocabulary.
const ROWS = [
    { gtfs_stop_id: '127', borough: 'M',  daytime_routes: '1 2 3',
      north_direction_label: 'Uptown',    south_direction_label: 'Downtown' },
    { gtfs_stop_id: 'R29', borough: 'Bk', daytime_routes: 'R',
      north_direction_label: 'Manhattan', south_direction_label: 'Southbound' },
    { gtfs_stop_id: 'A41', borough: 'Bk', daytime_routes: 'A C F',
      north_direction_label: 'Manhattan', south_direction_label: 'Outbound' },
    { gtfs_stop_id: 'F12', borough: 'M',  daytime_routes: 'E M',
      north_direction_label: 'Queens',    south_direction_label: 'Downtown' },
    { gtfs_stop_id: '101', borough: 'Bx', daytime_routes: '1',
      north_direction_label: 'Last Stop', south_direction_label: 'Manhattan' },
    { gtfs_stop_id: 'R45', borough: 'Bk', daytime_routes: 'R',
      north_direction_label: 'Manhattan', south_direction_label: 'Last Stop' },
    { gtfs_stop_id: 'G21', borough: 'Q',  daytime_routes: 'E M R',
      north_direction_label: 'Queens',    south_direction_label: 'Manhattan' },
    // The shuttle platform at Times Sq. Its route ids are GS/FS/H but the
    // dataset lists the display name, which is what breaks a naive id match.
    { gtfs_stop_id: '902', borough: 'M',  daytime_routes: 'S',
      north_direction_label: 'Last Stop', south_direction_label: 'Grand Central' },
];
const meta = buildStationMeta(ROWS);

describe('buildStationMeta', () => {
    it('indexes rows by stop id and splits routes into a set', () => {
        expect(meta.size).toBe(ROWS.length);
        expect([...meta.get('A41').routes].sort()).toEqual(['A', 'C', 'F']);
        expect(meta.get('R29').borough).toBe('Bk');
    });

    it('skips rows with no stop id, and tolerates missing input', () => {
        expect(buildStationMeta([{ borough: 'M' }]).size).toBe(0);
        expect(buildStationMeta(undefined).size).toBe(0);
        expect(buildStationMeta([]).size).toBe(0);
    });

    it('treats an absent daytime_routes as no routes rather than one empty one', () => {
        const m = buildStationMeta([{ gtfs_stop_id: 'X', borough: 'M' }]);
        expect(m.get('X').routes.size).toBe(0);
    });
});

describe('stopIdForTrunk', () => {
    // Jay St is one complex with two rows; which one describes "Manhattan"
    // depends on which platform the rider means.
    it('picks the row whose routes serve the trunk', () => {
        expect(stopIdForTrunk(meta, ['A41', 'R29'], ['A', 'C', 'E'])).toBe('A41');
        expect(stopIdForTrunk(meta, ['A41', 'R29'], ['N', 'Q', 'R', 'W'])).toBe('R29');
    });

    it('falls back to the first known id when no trunk matches', () => {
        expect(stopIdForTrunk(meta, ['A41', 'R29'], ['7'])).toBe('A41');
    });

    // The bug this signature exists to prevent: matching GTFS route ids against
    // a column that holds display names finds nothing, and the lookup silently
    // falls through to whichever platform is listed first — which is how the
    // 42 St Shuttle came to be labeled "Uptown / Downtown".
    it('matches the shuttle by its display name, not its route ids', () => {
        const ids = ['127', '902'];
        expect(stopIdForTrunk(meta, ids, ['GS', 'FS', 'H'])).toBe('127');   // ids: wrong
        expect(stopIdForTrunk(meta, ids, ['S'])).toBe('902');               // labels: right
    });

    it('returns null when nothing is known', () => {
        expect(stopIdForTrunk(meta, ['ZZZ'], ['A'])).toBeNull();
        expect(stopIdForTrunk(meta, [], ['A'])).toBeNull();
        expect(stopIdForTrunk(meta, undefined, undefined)).toBeNull();
    });
});

describe('routeLabelsFor', () => {
    const routeMap = {
        GS: { shortName: 'S' }, FS: { shortName: 'S' }, H: { shortName: 'S' },
        '7': { shortName: '7' }, '7X': { shortName: '7X' },
    };

    it('maps route ids to their display names', () => {
        expect(routeLabelsFor(['GS', 'FS', 'H'], routeMap)).toEqual(['S', 'S', 'S']);
    });

    it('falls back to the id when the route is unknown', () => {
        expect(routeLabelsFor(['ZZ'], routeMap)).toEqual(['ZZ']);
    });

    it('handles empty and missing input', () => {
        expect(routeLabelsFor([], routeMap)).toEqual([]);
        expect(routeLabelsFor(undefined, undefined)).toEqual([]);
    });
});

describe('directionLabel', () => {
    it("uses MTA's label when it names a place", () => {
        expect(directionLabel(meta, '127', 'N', '101')).toBe('Uptown');
        expect(directionLabel(meta, '127', 'S', '142')).toBe('Downtown');
        // In Manhattan, yet northbound is "Queens" — the E does not run uptown
        // from here. No geometric rule produces this.
        expect(directionLabel(meta, 'F12', 'N', 'G21')).toBe('Queens');
    });

    // The case the whole fallback exists for: the dataset says "Southbound",
    // MTA's app says "Brooklyn", and southbound R trains terminate in Brooklyn.
    it('substitutes the destination borough for a generic label', () => {
        expect(directionLabel(meta, 'R29', 'S', 'R45')).toBe('Brooklyn');
        expect(directionLabel(meta, 'A41', 'S', 'R45')).toBe('Brooklyn');
    });

    it('names The Bronx and Queens the way MTA does', () => {
        expect(directionLabel(meta, 'R29', 'S', '101')).toBe('The Bronx');
        expect(directionLabel(meta, 'R29', 'S', 'G21')).toBe('Queens');
    });

    it('keeps the generic label when the destination is unknown', () => {
        expect(directionLabel(meta, 'R29', 'S', 'NOPE')).toBe('Southbound');
        expect(directionLabel(meta, 'R29', 'S', undefined)).toBe('Southbound');
    });

    it('falls back to a compass heading for an unknown station', () => {
        expect(directionLabel(meta, 'NOPE', 'N', 'NOPE')).toBe('Northbound');
        expect(directionLabel(meta, 'NOPE', 'S', 'NOPE')).toBe('Southbound');
    });

    it('gives the shuttle its own labels once the right platform is found', () => {
        expect(directionLabel(meta, '902', 'S', '631')).toBe('Grand Central');
    });

    it('does not substitute a borough for a meaningful label', () => {
        // 101 northbound is "Last Stop"; that is information, not a placeholder.
        expect(directionLabel(meta, '101', 'N', 'R45')).toBe('Last Stop');
    });
});

describe('isLastStop', () => {
    it('detects a terminating direction', () => {
        expect(isLastStop(meta, '101', 'N')).toBe(true);
        expect(isLastStop(meta, '101', 'S')).toBe(false);
        expect(isLastStop(meta, 'R45', 'S')).toBe(true);
    });

    it('is false for unknown stations', () => {
        expect(isLastStop(meta, 'NOPE', 'N')).toBe(false);
    });
});

describe('boroughName', () => {
    it('maps every code the dataset uses', () => {
        expect(boroughName(meta, '127')).toBe('Manhattan');
        expect(boroughName(meta, 'R29')).toBe('Brooklyn');
        expect(boroughName(meta, 'G21')).toBe('Queens');
        expect(boroughName(meta, '101')).toBe('The Bronx');
    });

    it('returns an empty string for unknown stations', () => {
        expect(boroughName(meta, 'NOPE')).toBe('');
    });
});
