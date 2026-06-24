// src/scene/renderer.js
// Maplibre owns the map, camera, and canvas. Three.js renders subway geometry
// into the same WebGL context via a Maplibre custom layer — one canvas, two
// renderers, perfectly synced camera on every frame.

import * as THREE from 'three';
import maplibregl from 'maplibre-gl';
import { MAP_CENTER } from '../core/geo.js';

const STYLE_URL = 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json';

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
