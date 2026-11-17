import { describe, it, expect } from 'vitest';
import { validateStyleMin, createPropertyExpression, latest } from '@maplibre/maplibre-gl-style-spec';
import { addStationLayer } from '../../src/scene/renderer.js';
import { highlightStations } from '../../src/scene/lines.js';

// A fake map can't tell a valid expression from one Maplibre rejects: the
// station-line-stops layer (#160) first shipped with a filter Maplibre read as
// old key/value syntax, so the whole layer was dropped at runtime while every
// unit test passed. These run the real layer definitions, and every value
// highlightStations sets, through Maplibre's own style validator.
// (@maplibre/maplibre-gl-style-spec comes with maplibre-gl.)

// Records sources and layers instead of drawing them.
function recordingMap() {
    const sources = {};
    const layers = [];
    return {
        sources, layers,
        addSource: (id, source) => { sources[id] = source; },
        addLayer: (layer) => { layers.push(layer); },
        getSource: () => ({ setData: () => {} }),
        getLayer: (id) => layers.find(l => l.id === id),
        setPaintProperty: (id, prop, value) => { const l = layers.find(x => x.id === id); l.paint = { ...l.paint, [prop]: value }; },
        setFilter: (id, value) => { layers.find(x => x.id === id).filter = value; },
        setLayoutProperty: (id, prop, value) => { const l = layers.find(x => x.id === id); l.layout = { ...l.layout, [prop]: value }; },
    };
}

function errorsFor(map) {
    return validateStyleMin({
        version: 8,
        glyphs: 'https://example.com/{fontstack}/{range}.pbf',
        sources: map.sources,
        layers: map.layers,
    }).map(e => e.message);
}

const complexes = [{ name: 'Jay St-MetroTech', stationIds: ['A41', 'R29'], lat: 40.692, lng: -73.987 }];
const stations = [
    { id: 'A41', name: 'Jay St-MetroTech', lat: 40.692, lng: -73.987 },
    { id: 'R29', name: 'Jay St-MetroTech', lat: 40.692, lng: -73.986 },
];
const counts = new Map([['A41', 3], ['R29', 1]]);
const byStation = new Map([['A41', new Set(['A', 'C', 'F'])], ['R29', new Set(['R'])]]);

describe('station layers', () => {
    it('are all valid Maplibre layers, the line stops layer included', () => {
        const map = recordingMap();
        addStationLayer(map, complexes, stations, counts, counts, byStation);

        expect(map.layers.map(l => l.id)).toContain('station-line-stops');
        expect(errorsFor(map)).toEqual([]);
    });

    it('stay valid with a line highlighted, and after it clears', () => {
        const map = recordingMap();
        addStationLayer(map, complexes, stations, counts, counts, byStation);

        highlightStations(map, ['A', '6X']);
        expect(errorsFor(map)).toEqual([]);

        highlightStations(map, null);
        expect(errorsFor(map)).toEqual([]);
    });
});

// A paint value at a zoom, the way Maplibre evaluates it.
function at(layer, prop, zoom, properties = {}) {
    const parsed = createPropertyExpression(layer.paint[prop], latest.paint_circle[prop]);
    if (parsed.result !== 'success') throw new Error(JSON.stringify(parsed.value));
    return parsed.value.evaluate({ zoom }, { properties });
}

describe('station dot size (#164)', () => {
    const map = recordingMap();
    addStationLayer(map, complexes, stations, counts, counts, byStation);
    const circles = map.layers.filter(l => l.type === 'circle');
    const layer = (id) => map.layers.find(l => l.id === id);

    it('is one curve on every station layer', () => {
        expect(circles.map(l => l.id).sort()).toEqual([
            'station-circles-major', 'station-circles-minor',
            'station-complexes-major', 'station-complexes-minor',
            'station-line-stops',
        ]);
        for (const l of circles) expect(l.paint['circle-radius']).toEqual(circles[0].paint['circle-radius']);
    });

    it('does not change at the split zoom, where complexes become platforms', () => {
        const complex = layer('station-complexes-major');
        const platform = layer('station-circles-major');
        expect(at(complex, 'circle-radius', 13)).toBe(at(platform, 'circle-radius', 13));
        expect(at(complex, 'circle-stroke-width', 13)).toBe(at(platform, 'circle-stroke-width', 13, { alert: false }));
    });

    it('is smaller at city zoom than it was, and 13.5 px across at the split', () => {
        const complex = layer('station-complexes-major');
        const across = (zoom) => 2 * (at(complex, 'circle-radius', zoom) + at(complex, 'circle-stroke-width', zoom));
        expect(across(10)).toBe(7);
        expect(across(11)).toBe(8.5);
        expect(across(12)).toBe(11);
        expect(across(13)).toBe(13.5);
    });

    it('keeps the thicker ring on an alerted platform', () => {
        expect(at(layer('station-circles-minor'), 'circle-stroke-width', 14, { alert: true })).toBe(3);
    });
});
