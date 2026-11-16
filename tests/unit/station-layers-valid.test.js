import { describe, it, expect } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
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
