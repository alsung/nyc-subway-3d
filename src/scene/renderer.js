// src/scene/renderer.js
// Maplibre owns the map, camera, and canvas. Three.js renders subway geometry
// into the same WebGL context via a Maplibre custom layer — one canvas, two
// renderers, perfectly synced camera on every frame.

import * as THREE from 'three';
import maplibregl from 'maplibre-gl';
import { MAP_CENTER } from '../core/geo.js';

const STADIA_KEY = import.meta.env.VITE_STADIA_API_KEY;
const STYLE_URL = STADIA_KEY
    ? `https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json?api_key=${STADIA_KEY}`
    : 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json';

// Creates the Maplibre map centered on NYC with a dark street style.
// Drag, zoom, and pitch are all handled natively by Maplibre.
export function createMap(container) {
    return new maplibregl.Map({
        container,
        style: STYLE_URL,
        center: [MAP_CENTER.lng, MAP_CENTER.lat],
        zoom: 12,
        pitch: 56,
        bearing: -17,
        antialias: true,
    });
}

// Two-tier station rendering: below zoom 13 shows one merged dot per named
// complex (centroid of same-name stations); at zoom 13+ individual station
// circles replace them. Both sources store stationIds as a pipe-separated
// string so the click handler works uniformly across all four layers.
export function addStationLayer(map, complexes, stations, complexRouteCounts, routeCounts) {
    map.addSource('station-complexes', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: complexes.map(c => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
                properties: {
                    name: c.name,
                    stationIds: c.stationIds.join('|'),
                    major: (complexRouteCounts.get(c.stationIds[0]) ?? 1) >= 3 ? 1 : 0,
                },
            })),
        },
    });

    map.addSource('stations', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: stations.map(s => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
                properties: {
                    name: s.name,
                    stationIds: s.id,
                    major: (routeCounts.get(s.id) ?? 1) >= 3 ? 1 : 0,
                },
            })),
        },
    });

    // Complex dots — visible below zoom 13
    map.addLayer({
        id: 'station-complexes-major',
        type: 'circle',
        source: 'station-complexes',
        minzoom: 10,
        maxzoom: 13,
        filter: ['==', ['get', 'major'], 1],
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 12, 7],
            'circle-color': '#ffffff',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 12, 2],
            'circle-stroke-color': '#222222',
        },
    });

    map.addLayer({
        id: 'station-complexes-minor',
        type: 'circle',
        source: 'station-complexes',
        minzoom: 11,
        maxzoom: 13,
        filter: ['==', ['get', 'major'], 0],
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 12, 4],
            'circle-color': '#cccccc',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 12, 1.5],
            'circle-stroke-color': '#222222',
        },
    });

    // Individual circles + labels — visible from zoom 13
    map.addLayer({
        id: 'station-circles-major',
        type: 'circle',
        source: 'stations',
        minzoom: 13,
        filter: ['==', ['get', 'major'], 1],
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 5, 16, 9],
            'circle-color': '#ffffff',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 16, 2],
            'circle-stroke-color': '#222222',
        },
    });

    map.addLayer({
        id: 'station-circles-minor',
        type: 'circle',
        source: 'stations',
        minzoom: 13,
        filter: ['==', ['get', 'major'], 0],
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 3, 16, 7],
            'circle-color': '#cccccc',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 16, 1.5],
            'circle-stroke-color': '#222222',
        },
    });

    map.addLayer({
        id: 'station-labels',
        type: 'symbol',
        source: 'stations',
        minzoom: 13,
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
