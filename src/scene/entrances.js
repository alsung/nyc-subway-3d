// src/scene/entrances.js
// Street entrances for the station currently open in the popup.
//
// One complex at a time, not everything at street zoom. The median complex has
// four entrances, but 78 fall within 350 m of Fulton St — about one screenful —
// and Chambers St/WTC alone has 35. Drawing them all turns Lower Manhattan into
// confetti in exactly the place where knowing which stair to take matters most.
// Tying them to the selection also ties them to the moment they are useful.

import { entranceLabel } from '../core/entrances.js';

// Only elevators are colored. Everything else is a neutral dot, because a
// legend nobody reads is not how a rider learns what a color means — the
// labels below carry that instead.
//
// Deliberately dimmer and smaller than a station circle, which is white at
// radius 5. The first pass drew entrances at radius 4 in near-white, and around
// Times Sq the twenty-eight of them were indistinguishable from the four
// station dots they surround. A station is the anchor; entrances are satellites
// of it, and the hierarchy has to be visible at a glance rather than on
// inspection.
const ELEVATOR_COLOR = '#4caf7d';
const PLAIN_COLOR = '#8f96a3';
const STROKE_COLOR = '#0a0a1a';

// Below this the station itself is still a single dot, so pinning entrances to
// the sidewalk they are on would be a lie about the precision available.
const ENTRANCE_MINZOOM = 15;

// The labels are the whole point of the layer, so they appear a little later
// than the dots rather than the other way round.
const LABEL_MINZOOM = 15.5;

const EMPTY = { type: 'FeatureCollection', features: [] };

/**
 * Adds the entrance source and its two layers, initially empty.
 *
 * Safe to call once at startup: nothing is drawn until setEntrancesFor runs.
 */
export function addEntranceLayer(map) {
    if (map.getSource('station-entrances')) return;

    map.addSource('station-entrances', { type: 'geojson', data: EMPTY });

    map.addLayer({
        id: 'entrance-dots',
        type: 'circle',
        source: 'station-entrances',
        minzoom: ENTRANCE_MINZOOM,
        paint: {
            'circle-radius': 3.5,
            // Exit-only entrances read as hollow: the fill drops to the map's
            // own background rather than to transparent, so the ring stays a
            // ring instead of letting the basemap show through and muddying it.
            'circle-color': [
                'case',
                ['!', ['get', 'entry']], STROKE_COLOR,
                ['==', ['get', 'type'], 'elevator'], ELEVATOR_COLOR,
                PLAIN_COLOR,
            ],
            'circle-stroke-width': 1.25,
            'circle-stroke-color': [
                'case',
                ['==', ['get', 'type'], 'elevator'], ELEVATOR_COLOR,
                PLAIN_COLOR,
            ],
        },
    });

    map.addLayer({
        id: 'entrance-labels',
        type: 'symbol',
        source: 'station-entrances',
        minzoom: LABEL_MINZOOM,
        filter: ['has', 'label'],
        layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Stadia Regular'],
            'text-size': 10,
            'text-offset': [0, 0.9],
            'text-anchor': 'top',
            // A label that cannot be placed is dropped rather than nudged: two
            // entrances on opposite corners of one intersection are a common
            // arrangement, and a shifted label points at the wrong stair.
            'text-allow-overlap': false,
        },
        paint: {
            'text-color': '#c8ced8',
            'text-halo-color': STROKE_COLOR,
            'text-halo-width': 1.2,
        },
    });
}

/**
 * Shows the given entrances and hides everything else. Pass null or [] to clear.
 *
 * Safe before the layer exists — the popup can open on a station before the
 * map finishes loading, and a dropped call is better than a thrown one.
 */
export function setEntrancesFor(map, entrances) {
    const source = map?.getSource?.('station-entrances');
    if (!source) return;

    const features = (entrances ?? []).map(e => {
        const label = entranceLabel(e);
        return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
            // label is omitted rather than set to null so the layer's
            // ['has', 'label'] filter can do the work.
            properties: { type: e.type, entry: e.entry, exit: e.exit, ...(label ? { label } : {}) },
        };
    });

    source.setData({ type: 'FeatureCollection', features });
}
