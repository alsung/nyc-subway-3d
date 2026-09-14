import { describe, it, expect } from 'vitest';
import { filterStations, idsFor, MAX_RESULTS } from '../../src/ui/search.js';

const stations = [
    { id: '127', name: 'Times Sq-42 St' },
    { id: '725', name: 'Times Sq-42 St' },
    { id: '631', name: 'Grand Central-42 St' },
    { id: 'L08', name: 'Bedford Av' },
    { id: '635', name: '14 St-Union Sq' },
    { id: 'A02', name: 'Inwood-207 St' },
];

describe('filterStations', () => {
    it('matches anywhere in the name, not just the start', () => {
        // A rider types what they remember, which is often the cross street.
        const got = filterStations(stations, '42 St').map(s => s.name);
        expect(got).toContain('Times Sq-42 St');
        expect(got).toContain('Grand Central-42 St');
    });

    it('ignores case', () => {
        expect(filterStations(stations, 'bedford')).toHaveLength(1);
        expect(filterStations(stations, 'BEDFORD')).toHaveLength(1);
    });

    it('returns nothing for an empty or whitespace query', () => {
        // Not everything — an empty box should show no dropdown at all.
        expect(filterStations(stations, '')).toEqual([]);
        expect(filterStations(stations, '   ')).toEqual([]);
        expect(filterStations(stations, null)).toEqual([]);
        expect(filterStations(stations, undefined)).toEqual([]);
    });

    it('caps the list so it stays scannable', () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ id: String(i), name: `${i} St` }));
        expect(filterStations(many, 'St')).toHaveLength(MAX_RESULTS);
        expect(filterStations(many, 'St', 3)).toHaveLength(3);
    });

    it('keeps both platforms of a complex, which share a name', () => {
        // Times Sq is several GTFS stations; the caller decides what to do with
        // that, and hiding one here would hide a valid destination.
        expect(filterStations(stations, 'Times Sq')).toHaveLength(2);
    });

    it('survives missing input', () => {
        expect(filterStations(null, 'a')).toEqual([]);
        expect(filterStations([null, undefined, { id: 'x' }], 'a')).toEqual([]);
    });
});

describe('idsFor', () => {
    it('namespaces every id a search instance owns', () => {
        const ids = idsFor('trip-from');
        expect(ids.listbox).toBe('trip-from-results');
        expect(ids.option(0)).toBe('trip-from-result-0');
        expect(ids.option(7)).toBe('trip-from-result-7');
    });

    it('never collides between instances', () => {
        // Two search boxes on one page would otherwise both claim
        // id="search-results", and aria-controls would resolve to whichever the
        // browser found first — a screen reader quietly pointed at the wrong
        // list, with nothing thrown.
        const a = idsFor('trip-from');
        const b = idsFor('trip-to');
        expect(a.listbox).not.toBe(b.listbox);
        for (let i = 0; i < MAX_RESULTS; i++) {
            expect(a.option(i)).not.toBe(b.option(i));
        }
    });
});
