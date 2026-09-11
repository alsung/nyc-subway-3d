// src/scene/renderer.js
// Maplibre owns the map, camera, and canvas. Three.js renders subway geometry
// into the same WebGL context via a Maplibre custom layer — one canvas, two
// renderers, perfectly synced camera on every frame.

import * as THREE from 'three';
import maplibregl from 'maplibre-gl';
import { MAP_CENTER } from '../core/geo.js';
import { segmentCoords } from '../core/corridors.js';

const STADIA_KEY = import.meta.env.VITE_STADIA_API_KEY;
const STYLE_URL = STADIA_KEY
    ? `https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json?api_key=${STADIA_KEY}`
    : 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json';

// The zoom at which the map swaps between its two representations of a route.
//
// Below it, routes are flat Maplibre line layers; above it, Three.js tubes.
// Neither works at both distances: tube geometry collapses into a thread when
// seen from across the city, and a flat line cannot show that one route passes
// beneath another. Exported because the swap has two halves — the line layer's
// own maxzoom and the tube visibility handler — and a threshold expressed twice
// is a threshold that drifts.
export const TUBE_ZOOM = 14;

// Creates the Maplibre map centered on NYC with a dark street style.
// Drag, zoom, and pitch are all handled natively by Maplibre.
//
// Opens flat, and stays flat at this zoom: pitch now follows zoom (see
// camera.js), so the overview is upright and the camera tilts on approach. That
// also keeps the initial tile set small, which is what a tilted opening camera
// used to cost — it pushed the horizon back and dominated time-to-interactive.
export function createMap(container) {
    return new maplibregl.Map({
        container,
        style: STYLE_URL,
        center: [MAP_CENTER.lng, MAP_CENTER.lat],
        zoom: 12,
        pitch: 0,
        bearing: 0,
        antialias: true,
    });
}

// Two-tier station rendering: below zoom 13 shows one merged dot per named
// complex (centroid of same-name stations); at zoom 13+ individual station
// circles replace them. Both sources store stationIds as a pipe-separated
// string so the click handler works uniformly across all four layers.
// Color of the ring drawn around a station with an active alert. Matches the
// incident tone used by the status button and the alerts panel.
const ALERT_STROKE = '#ffb020';
const PLAIN_STROKE = '#222222';

// The MTA's own gray, for a route the feed does not describe.
const UNKNOWN_ROUTE_COLOR = '#808183';

// Flat-line width, and the strand spacing that tracks it. Spacing equals width
// so strands sit edge to edge: the MTA app draws a packed ribbon, not a fan
// with gaps, and four touching stripes read as one line of four services.
const LINE_WIDTH_BY_ZOOM = ['interpolate', ['linear'], ['zoom'], 10, 2.2, 13, 5];
const STRAND_SPACING_PX_MIN = 2.2;
const STRAND_SPACING_PX_MAX = 5;

// One radius for every station dot, at every zoom.
//
// The circles used to grow with zoom — 4→7 for complexes, 5→9 for individual
// stations — which made the same station a different size depending on how far
// in you happened to be, and made the map feel like it was breathing while you
// navigated. A station is a station: constant size reads as a consistent symbol
// rather than a scaling decoration, and it keeps the network's shape legible at
// the moment complexes split into their constituent platforms.
const STATION_RADIUS = 5;
const STATION_STROKE = 1.75;

// Where a complex stops being one dot and becomes its own platforms. Both the
// complex layers' maxzoom and the individual layers' minzoom, so exactly one
// representation is on screen at any zoom.
const SPLIT_ZOOM = 13;

// Held so the sources can be rebuilt when alerts arrive; the feature geometry
// never changes, only the `alert` flag on each.
let stationFeatures = null;
let complexFeatures = null;

export function addStationLayer(map, complexes, stations, complexRouteCounts, routeCounts) {
    complexFeatures = complexes.map(c => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
        properties: {
            name: c.name,
            stationIds: c.stationIds.join('|'),
            major: (complexRouteCounts.get(c.stationIds[0]) ?? 1) >= 3 ? 1 : 0,
            alert: false,
        },
    }));

    stationFeatures = stations.map(s => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: {
            name: s.name,
            stationIds: s.id,
            major: (routeCounts.get(s.id) ?? 1) >= 3 ? 1 : 0,
            alert: false,
        },
    }));

    map.addSource('station-complexes', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: complexFeatures },
    });

    map.addSource('stations', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: stationFeatures },
    });

    // Complex dots — visible below zoom 13
    map.addLayer({
        id: 'station-complexes-major',
        type: 'circle',
        source: 'station-complexes',
        minzoom: 10,
        maxzoom: SPLIT_ZOOM,
        filter: ['==', ['get', 'major'], 1],
        paint: {
            'circle-radius': STATION_RADIUS,
            'circle-color': '#ffffff',
            'circle-stroke-width': STATION_STROKE,
            'circle-stroke-color': PLAIN_STROKE,
        },
    });

    map.addLayer({
        id: 'station-complexes-minor',
        type: 'circle',
        source: 'station-complexes',
        minzoom: 11,
        maxzoom: SPLIT_ZOOM,
        filter: ['==', ['get', 'major'], 0],
        paint: {
            'circle-radius': STATION_RADIUS,
            'circle-color': '#ffffff',
            'circle-stroke-width': STATION_STROKE,
            'circle-stroke-color': PLAIN_STROKE,
        },
    });

    // Individual circles + labels — visible from zoom 13
    map.addLayer({
        id: 'station-circles-major',
        type: 'circle',
        source: 'stations',
        minzoom: SPLIT_ZOOM,
        filter: ['==', ['get', 'major'], 1],
        paint: {
            'circle-radius': STATION_RADIUS,
            'circle-color': '#ffffff',
            // Alerted stations get a thicker amber ring. Only the individual
            // circles carry it, never the complex dots below zoom 13: a third
            // of the system is typically named by some alert, and at city zoom
            // that is a wall of amber rather than a signal.
            //
            // The zoom interpolation has to stay on the outside with the data
            // lookup in each stop value. Maplibre permits only one zoom-based
            // subexpression per property, so wrapping two interpolates in a
            // case fails to parse and the layer silently falls back to default.
            // Constant, like the radius — only the alert state changes it.
            'circle-stroke-width': ['case', ['get', 'alert'], 3, STATION_STROKE],
            'circle-stroke-color': ['case', ['get', 'alert'], ALERT_STROKE, PLAIN_STROKE],
        },
    });

    map.addLayer({
        id: 'station-circles-minor',
        type: 'circle',
        source: 'stations',
        minzoom: SPLIT_ZOOM,
        filter: ['==', ['get', 'major'], 0],
        paint: {
            'circle-radius': STATION_RADIUS,
            'circle-color': '#ffffff',
            'circle-stroke-width': ['case', ['get', 'alert'], 3, STATION_STROKE],
            'circle-stroke-color': ['case', ['get', 'alert'], ALERT_STROKE, PLAIN_STROKE],
        },
    });

    // Labeled from the complex source, not the platform source, and with no
    // maxzoom so one name persists at every zoom above the split. Labelling
    // platforms rendered "Times Sq-42 St" three times side by side, once per
    // GTFS station in the complex.
    map.addLayer({
        id: 'station-labels',
        type: 'symbol',
        source: 'station-complexes',
        minzoom: SPLIT_ZOOM,
        layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Stadia Regular'],
            'text-size': 11,
            'text-offset': [0, 1.1],
            'text-anchor': 'top',
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#0a0a1a',
            'text-halo-width': 1.2,
        },
    });
}

/**
 * Flags which stations currently have an alert, repainting their rings.
 *
 * Rebuilds the source data rather than using setFeatureState: the features
 * carry no ids, and state would have to be cleared entry by entry each refresh
 * to drop stations whose alert has ended. Reassigning one boolean across ~500
 * point features is cheap and cannot leave a stale badge behind.
 *
 * Safe to call before the layer exists — the RT loop starts as soon as the map
 * loads, which can precede the first alerts response either way round.
 */
export function setStationAlerts(map, alertedIds) {
    if (!stationFeatures || !map.getSource('stations')) return;

    const ids = alertedIds ?? new Set();
    for (const f of stationFeatures) {
        f.properties.alert = ids.has(f.properties.stationIds);
    }
    // Complexes span several station ids; the dot is flagged if any of them is.
    for (const f of complexFeatures) {
        f.properties.alert = f.properties.stationIds.split('|').some(id => ids.has(id));
    }

    map.getSource('stations').setData({ type: 'FeatureCollection', features: stationFeatures });
    map.getSource('station-complexes').setData({ type: 'FeatureCollection', features: complexFeatures });
}

// Creates a Maplibre custom layer that hosts a Three.js scene.
// Call map.addLayer(layer) after the map's 'load' event fires; from that
// point layer.scene is ready for buildLineMeshes / buildStationMeshes / etc.
// layer.onTick(delta) can be assigned afterward to drive per-frame animation.
export function createThreeLayer(id) {
    const origin = maplibregl.MercatorCoordinate.fromLngLat(
        [MAP_CENTER.lng, MAP_CENTER.lat],
        0
    );
    const metersToMercator = origin.meterInMercatorCoordinateUnits();

    // Local meters (from geoToLocalMeters) -> Mercator world space.
    // No axis permutation needed: local x/y already match Mercator x/y
    // (east, south), so this is a plain translate + uniform scale.
    const modelMatrix = new THREE.Matrix4()
        .makeTranslation(origin.x, origin.y, origin.z)
        .scale(new THREE.Vector3(metersToMercator, metersToMercator, metersToMercator));

    return {
        id,
        type: 'custom',
        renderingMode: '3d',

        onAdd(map, gl) {
            this.map = map;
            this.camera = new THREE.Camera();
            this.scene = new THREE.Scene();

            this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
            const sun = new THREE.DirectionalLight(0xffffff, 1.0);
            sun.position.set(0, -70, 100).normalize();
            this.scene.add(sun);

            this.renderer = new THREE.WebGLRenderer({
                canvas: map.getCanvas(),
                context: gl,
                antialias: true,
            });
            this.renderer.autoClear = false;
            this.clock = new THREE.Clock();
        },

        render(gl, args) {
            const projection = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
            this.camera.projectionMatrix = projection.multiply(modelMatrix);

            this.onTick?.(this.clock.getDelta());

            this.renderer.resetState();
            this.renderer.render(this.scene, this.camera);
            this.map.triggerRepaint();
        },
    };
}

/**
 * The GeoJSON features behind the flat route layer.
 *
 * One feature per corridor segment rather than per route, because a route's
 * strand position changes along its length: the M sits between B/D and F on
 * 6 Av and somewhere else entirely on Queens Blvd. Maplibre's line-offset is
 * one value per feature, so the geometry has to be cut where the rank changes.
 *
 * A route is several polylines when it has branches, and each is cut
 * independently.
 *
 * Exported for its own sake — the layer wiring below needs a live map, this
 * does not, and the interesting part is the cutting.
 *
 * @param {Record<string, [number, number][][]>} lineRoutes routeId -> polylines
 * @param {Map<string, object[][]>} corridors from buildCorridors
 * @param {Record<string, {color?: string}>} routeMap
 * @returns {{type: 'FeatureCollection', features: object[]}}
 */
export function routeLineFeatures(lineRoutes, corridors, routeMap) {
    const features = [];

    for (const [routeId, polylines] of Object.entries(lineRoutes ?? {})) {
        if (!Array.isArray(polylines)) continue;
        const color = routeMap?.[routeId]?.color ?? UNKNOWN_ROUTE_COLOR;
        const perPolyline = corridors?.get(routeId) ?? [];

        for (let i = 0; i < polylines.length; i++) {
            const coords = polylines[i];
            if (!coords || coords.length < 2) continue;

            // A polyline with no corridor data still has to be drawn, at rank 0
            // — a missing entry should cost the line its strand, not its
            // existence.
            const segments = perPolyline[i]
                ?? [{ from: 0, to: coords.length - 1, rank: 0, flip: false }];

            for (const segment of segments) {
                const slice = segmentCoords(coords, segment);
                if (slice.length < 2) continue;
                features.push({
                    type: 'Feature',
                    properties: { routeId, color, rank: segment.rank },
                    // lineRoutes stores [lat, lng]; GeoJSON wants [lng, lat].
                    geometry: { type: 'LineString', coordinates: slice.map(([lat, lng]) => [lng, lat]) },
                });
            }
        }
    }

    return { type: 'FeatureCollection', features };
}

/**
 * Draws every route as a flat line, for zooms below TUBE_ZOOM.
 *
 * Built from lineRoutes — the same source the tubes are built from — so the two
 * representations can never disagree about where a line runs.
 *
 * Inserted beneath the station circles so the dots stay readable on top of it.
 */
export function addRouteLines(map, lineRoutes, routeMap, corridors) {
    map.addSource('route-lines', {
        type: 'geojson',
        data: routeLineFeatures(lineRoutes, corridors, routeMap),
    });

    map.addLayer({
        id: 'route-lines',
        type: 'line',
        source: 'route-lines',
        maxzoom: TUBE_ZOOM,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ['get', 'color'],
            // Wide enough at overview zoom to be the boldest thing on screen.
            // Suppressing the basemap alone does not make the subway legible —
            // it only makes a dim map dimmer; the routes have to become the
            // figure themselves.
            'line-width': LINE_WIDTH_BY_ZOOM,
            // Strand spacing tracks the line width, so the ribbon holds
            // together at every zoom instead of needing its own tuning curve.
            //
            // The zoom interpolation has to be the outermost expression, with
            // the data lookup inside each stop value. Multiplying an interpolate
            // by a ['get'] is rejected outright — "zoom expression may only be
            // used as input to a top-level step or interpolate" — the same rule
            // that bit the station rings above.
            'line-offset': [
                'interpolate', ['linear'], ['zoom'],
                10, ['*', ['get', 'rank'], STRAND_SPACING_PX_MIN],
                13, ['*', ['get', 'rank'], STRAND_SPACING_PX_MAX],
            ],
            'line-opacity': 0.95,
        },
    }, 'station-complexes-major');
}

// Basemap layers that carry no meaning for a subway map. Shields and points of
// interest are tuned for driving and compete directly with the subject.
const BASEMAP_HIDE = [
    'highway_shield_other', 'highway_shield_us_other', 'highway_shield_us_interstate',
    'highway_name_other', 'highway_name_major',
    'poi_gen1', 'poi_gen0_parks', 'poi_gen0_other',
    'airport_label_gen0',
];

// Roads and place names stay, quietly. Neighborhood names are how a New Yorker
// locates themselves on a map — useful context, just not at equal weight with
// the network. An earlier pass hid them outright and over-corrected.
const BASEMAP_DIM = [
    ['highway_motorway_inner', 0.25], ['highway_major_inner', 0.25],
    ['highway_minor', 0.25], ['highway_path', 0.2],
    ['highway_motorway_casing', 0.25], ['highway_major_casing', 0.25],
];
const LABEL_DIM = [
    ['place_suburb', 0.45], ['place_village', 0.45], ['place_town', 0.45],
    ['place_other', 0.45], ['place_city', 0.6],
];

/**
 * Quiets the basemap so the subway can be the figure rather than one more layer.
 *
 * Every layer id here belongs to Stadia's style, not ours. If they restyle, the
 * lookups miss and the map quietly becomes noisy again — nothing throws. The
 * guards make that a degradation rather than a crash, but it is a real
 * dependency on someone else's naming.
 */
export function applyBasemapRestraint(map) {
    for (const id of BASEMAP_HIDE) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    }
    for (const [id, opacity] of BASEMAP_DIM) {
        if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', opacity);
    }
    for (const [id, opacity] of LABEL_DIM) {
        if (map.getLayer(id)) map.setPaintProperty(id, 'text-opacity', opacity);
    }
}
