// src/main.js
// Application entry point. Wires every module together:
// GTFS data → scene objects → UI controls → animation loop.
// No business logic lives here — only coordination.

import * as THREE from 'three';
import { createRenderer, createScene, createCamera, onWindowResize } from './scene/renderer.js';
import { buildLineMeshes, setLineVisibility } from './scene/lines.js';
import { buildStationMeshes, getHitStation } from './scene/stations.js';
import { buildSimulatedTrains, tickTrains } from './scene/trains.js';
import { initOrbitControls, tweenTo, setView } from './ui/camera.js';
import { buildFilterChips } from './ui/filter.js';
import { buildPopup, showPopup, hidePopup } from './ui/popup.js';
import { buildSearch } from './ui/search.js';
import { loadAndParseGTFS } from './core/gtfs-loader.js';
import { geoToXZ } from './core/geo.js';

// Bootstraps the entire application. Async because GTFS loading is async;
// everything else runs synchronously inside once data is ready.
async function init() {
    const canvas = document.getElementById('canvas');
    const renderer = createRenderer(canvas);
    const scene = createScene();
    const camera = createCamera(canvas.clientWidth, canvas.clientHeight);
    const controls = initOrbitControls(camera, canvas);

    // Raycaster and mouse vector are reused on every click to avoid allocation.
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const { stations, routeMap, lineRoutes } = await loadAndParseGTFS();

    const lineMeshes = buildLineMeshes(lineRoutes, routeMap, scene);
    const stationMeshes = buildStationMeshes(stations, scene);
    const trainMeshes = buildSimulatedTrains(lineRoutes, routeMap, scene);

    const chipBar = document.getElementById('chip-bar');
    buildFilterChips(routeMap, chipBar, (routeId, active) => {
        setLineVisibility(lineMeshes, routeId, active);
    });

    const popup = buildPopup(document.getElementById('ui'));
    popup.querySelector('.popup-close').addEventListener('click', () => hidePopup(popup));

    buildSearch(stations, document.getElementById('search-bar'), (station) => {
        const { x, z } = geoToXZ(station.lat, station.lng);
        tweenTo(camera, controls, [x, 15, z + 10], [x, 0, z]);
        showPopup(popup, station, routeMap);
    });

    // Clicking a station disc flies the camera to that station and opens the popup.
    canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        mouse.set(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        raycaster.setFromCamera(mouse, camera);
        const station = getHitStation(stationMeshes, raycaster);
        if (station) {
            const { x, z } = geoToXZ(station.lat, station.lng);
            tweenTo(camera, controls, [x, 15, z + 10], [x, 0, z]);
            showPopup(popup, station, routeMap);
        }
    });

    document.getElementById('btn-2d').addEventListener('click', () => setView(camera, controls, '2d'));
    document.getElementById('btn-3d').addEventListener('click', () => setView(camera, controls, '3d'));

    window.addEventListener('resize', () => onWindowResize(renderer, camera));

    const clock = new THREE.Clock();

    function animate() {
        requestAnimationFrame(animate);
        const delta = clock.getDelta();
        tickTrains(trainMeshes, delta);
        controls.update();
        renderer.render(scene, camera);
    }

    animate();
}

init();
