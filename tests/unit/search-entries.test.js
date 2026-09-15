import { describe, it, expect } from 'vitest';
import { buildStationMeta, buildSearchEntries, searchEntryLabel } from '../../src/core/station-meta.js';

const meta = buildStationMeta([
    { gtfs_stop_id: '127', complex_id: '611', borough: 'M', daytime_routes: '1 2 3' },
    { gtfs_stop_id: '725', complex_id: '611', borough: 'M', daytime_routes: '7' },
    { gtfs_stop_id: 'R16', complex_id: '611', borough: 'M', daytime_routes: 'N Q R W' },
    { gtfs_stop_id: '902', complex_id: '611', borough: 'M', daytime_routes: 'S' },
    { gtfs_stop_id: 'A27', complex_id: '611', borough: 'M', daytime_routes: 'A C E' },
    { gtfs_stop_id: 'G20', complex_id: '272', borough: 'Q', daytime_routes: 'M R' },
    { gtfs_stop_id: 'R36', complex_id: '32', borough: 'Bk', daytime_routes: 'D N R' },
]);

const complex = (name, ids) => ({ name, lat: 40.75, lng: -73.98, stationIds: ids });

describe('buildSearchEntries', () => {
    it('collapses a complex to one row', () => {
        // Search used to list all 496 GTFS stations, so Times Sq appeared four
        // times — once per platform group.
        const entries = buildSearchEntries(
            [complex('Times Sq-42 St', ['127', '725', 'R16', '902', 'A27'])], meta);
        expect(entries).toHaveLength(1);
        expect(entries[0].stationIds).toHaveLength(5);
    });

    it('unions the routes across every member station', () => {
        const [e] = buildSearchEntries(
            [complex('Times Sq-42 St', ['127', '725', 'R16', '902', 'A27'])], meta);
        expect(e.routes).toEqual(['A', 'C', 'E', 'N', 'Q', 'R', 'W', '1', '2', '3', '7', 'S']);
    });

    it('orders routes by trunk, not alphabetically', () => {
        // As bullets these render blue, blue, orange, orange — the grouping a
        // rider sees on a station sign. Alphabetical would alternate colors.
        const m = buildStationMeta([
            { gtfs_stop_id: 'A15', complex_id: '439', borough: 'M', daytime_routes: 'A B C D' },
        ]);
        const [e] = buildSearchEntries([complex('125 St', ['A15'])], m);
        expect(e.routes).toEqual(['A', 'C', 'B', 'D']);
    });

    it('resolves the borough from the first member that knows one', () => {
        const [q, bk] = buildSearchEntries(
            [complex('36 St', ['G20']), complex('36 St', ['R36'])], meta);
        expect(q.borough).toBe('Queens');
        expect(bk.borough).toBe('Brooklyn');
    });

    it('carries the first member id, so a station lookup still resolves', () => {
        const [e] = buildSearchEntries([complex('Times Sq-42 St', ['127', '725'])], meta);
        expect(e.id).toBe('127');
    });

    it('survives missing metadata rather than dropping the station', () => {
        const [e] = buildSearchEntries([complex('Nowhere', ['ZZZ'])], meta);
        expect(e.name).toBe('Nowhere');
        expect(e.routes).toEqual([]);
        expect(e.borough).toBe('');
    });

    it('survives missing input', () => {
        expect(buildSearchEntries(null, meta)).toEqual([]);
        expect(buildSearchEntries([complex('X', [])], meta)[0].id).toBe('');
    });
});

describe('disambiguation — the cases that motivated this', () => {
    it('tells four Manhattan 125 Sts apart by routes alone', () => {
        // Borough is useless here: all four are in Manhattan.
        const m = buildStationMeta([
            { gtfs_stop_id: '116', complex_id: '153', borough: 'M', daytime_routes: '1' },
            { gtfs_stop_id: '225', complex_id: '306', borough: 'M', daytime_routes: '2 3' },
            { gtfs_stop_id: '621', complex_id: '392', borough: 'M', daytime_routes: '4 5 6' },
            { gtfs_stop_id: 'A15', complex_id: '439', borough: 'M', daytime_routes: 'A C B D' },
        ]);
        const entries = buildSearchEntries(
            ['116', '225', '621', 'A15'].map(id => complex('125 St', [id])), m);

        expect(new Set(entries.map(e => e.borough))).toEqual(new Set(['Manhattan']));
        const signatures = entries.map(e => e.routes.join(' '));
        expect(new Set(signatures).size).toBe(4);
    });

    it('needs the borough for 36 St, where routes overlap', () => {
        // Both serve the R, so bullets alone are ambiguous.
        const entries = buildSearchEntries(
            [complex('36 St', ['G20']), complex('36 St', ['R36'])], meta);
        expect(entries[0].routes).toContain('R');
        expect(entries[1].routes).toContain('R');
        expect(entries[0].borough).not.toBe(entries[1].borough);
    });
});

describe('searchEntryLabel', () => {
    it('reads as speech, not as concatenated bullets', () => {
        // The row's text content would announce as "Times Sq-42 St123 7ACE…".
        const [e] = buildSearchEntries([complex('Times Sq-42 St', ['127', 'R16'])], meta);
        expect(searchEntryLabel(e)).toBe('Times Sq-42 St, lines N Q R W 1 2 3, Manhattan');
    });

    it('omits parts it does not have', () => {
        expect(searchEntryLabel({ name: 'Nowhere', routes: [], borough: '' })).toBe('Nowhere');
        expect(searchEntryLabel({ name: 'X', routes: ['1'] })).toBe('X, lines 1');
    });

    it('survives missing input', () => {
        expect(searchEntryLabel(null)).toBe('');
        expect(searchEntryLabel({})).toBe('');
    });
});
