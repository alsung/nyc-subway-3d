import { describe, it, expect } from 'vitest';
import { highlightStations, stationsOn, onLitLine } from '../../src/scene/lines.js';

// Records what highlightStations asks of the map, layer by layer.
function fakeMap({ ready = true } = {}) {
    const paint = {};
    const filters = {};
    const layout = {};
    return {
        paint, filters, layout,
        getLayer: (id) => (ready ? { id } : undefined),
        setPaintProperty: (layer, prop, value) => { paint[`${layer}.${prop}`] = value; },
        setFilter: (layer, value) => { filters[layer] = value; },
        setLayoutProperty: (layer, prop, value) => { layout[`${layer}.${prop}`] = value; },
    };
}

describe('stationsOn', () => {
    it('matches a station any of the lines stops at, by whole line id', () => {
        expect(stationsOn(['A'])).toEqual(['any', ['in', '|A|', ['get', 'lines']]]);
    });

    it('counts an express route as its line, once', () => {
        expect(stationsOn(['6', '6X'])).toEqual(['any', ['in', '|6|', ['get', 'lines']]]);
    });

    it('matches nothing given no lines', () => {
        expect(stationsOn(null)).toBeNull();
        expect(stationsOn([])).toBeNull();
        expect(stationsOn([undefined])).toBeNull();
    });
});

describe('highlightStations', () => {
    it('keeps the line\'s stations bright, dims the rest and shows its stops', () => {
        const map = fakeMap();
        highlightStations(map, ['G']);

        const expected = ['case', ['any', ['in', '|G|', ['get', 'lines']]], 1, 0.15];
        for (const layer of ['station-complexes-major', 'station-complexes-minor', 'station-circles-major', 'station-circles-minor']) {
            expect(map.paint[`${layer}.circle-opacity`]).toEqual(expected);
            expect(map.paint[`${layer}.circle-stroke-opacity`]).toEqual(expected);
        }
        expect(map.paint['station-labels.text-opacity']).toEqual(expected);
        expect(map.filters['station-line-stops']).toEqual(['any', ['in', '|G|', ['get', 'lines']]]);
        expect(map.layout['station-line-stops.visibility']).toBe('visible');
    });

    it('puts every station back given no line', () => {
        const map = fakeMap();
        highlightStations(map, ['G']);
        highlightStations(map, null);

        expect(map.paint['station-circles-minor.circle-opacity']).toBe(1);
        expect(map.paint['station-labels.text-opacity']).toBe(1);
        expect(map.filters['station-line-stops']).toEqual(['boolean', false]);
        expect(map.layout['station-line-stops.visibility']).toBe('none');
    });

    it('does nothing before the station layers exist', () => {
        const map = fakeMap({ ready: false });
        highlightStations(map, ['G']);
        expect(map.paint).toEqual({});
    });
});

describe('onLitLine', () => {
    const station = (lines) => ({ properties: { lines } });

    it('is true for a station on a lit line, counting an express route as its line', () => {
        highlightStations(fakeMap(), ['6X']);
        expect(onLitLine(station('|4|5|6|'))).toBe(true);
        expect(onLitLine(station('|4|5|'))).toBe(false);
    });

    it('matches whole line ids, so the S does not light the SI', () => {
        highlightStations(fakeMap(), ['S']);
        expect(onLitLine(station('|SI|'))).toBe(false);
    });

    it('is false for every station once the line clears, or without line data', () => {
        highlightStations(fakeMap(), ['G']);
        expect(onLitLine(station(''))).toBe(false);
        expect(onLitLine({})).toBe(false);
        highlightStations(fakeMap(), null);
        expect(onLitLine(station('|G|'))).toBe(false);
    });
});
