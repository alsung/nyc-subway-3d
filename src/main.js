// src/main.js
// Application entry point. Wires every module together:
// GTFS data → scene objects → UI controls → RT refresh loop → animation loop.
// No business logic lives here — only coordination.

import * as THREE from 'three';
import { createRenderer, createScene, createCamera, onWindowResize } from './scene/renderer.js';
import { buildLineMeshes, setLineVisibility, highlightLine, clearLineHighlight } from './scene/lines.js';
import { buildStationMeshes, getHitStation } from './scene/stations.js';
import { buildSimulatedTrains, tickTrains } from './scene/trains.js';
import { initOrbitControls, tweenTo, setView } from './ui/camera.js';
import { buildFilterChips } from './ui/filter.js';
import { buildPopup, showPopup, hidePopup } from './ui/popup.js';
import { buildSearch } from './ui/search.js';
import { loadAndParseGTFS } from './core/gtfs-loader.js';
import { loadRT } from './core/rt-loader.js';
import { buildArrivalIndex } from './core/rt-parser.js';
import { geoToXZ } from './core/geo.js';

const RT_REFRESH_MS  = 30_000;
const RT_STALE_MS    = 90_000;

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

    const { lineMeshes, lineCurves } = buildLineMeshes(lineRoutes, routeMap, scene);
    const stationMeshes = buildStationMeshes(stations, scene);
    const trainMeshes   = buildSimulatedTrains(lineCurves, routeMap, scene);

    const chipBar = document.getElementById('chip-bar');
    buildFilterChips(routeMap, chipBar, (routeId, active) => {
        setLineVisibility(lineMeshes, routeId, active);
    });

    const popup = buildPopup(document.getElementById('ui'));
    popup.querySelector('.popup-close').addEventListener('click', () => {
        hidePopup(popup);
        clearLineHighlight(lineMeshes);
        lastStation = null;
    });

    // RT state — shared between the refresh loop and click/search handlers.
    let arrivalIndex = {};
    let lastStation  = null;

    function getArrivals(station) {
        return arrivalIndex[station.id] ?? null;
    }

    // Fetches fresh RT data, rebuilds the arrival index, updates the staleness
    // indicator, and re-renders the popup if it's currently open.
    async function refreshRT() {
        const staleEl = document.getElementById('staleness');
        try {
            const { feeds, fetchedAt } = await loadRT();
            const anyLoaded = feeds.some(f => f !== null);

            if (!anyLoaded) {
                staleEl.classList.remove('hidden');
                staleEl.classList.add('stale');
                document.getElementById('staleness-label').textContent = 'Offline';
                return;
            }

            arrivalIndex = buildArrivalIndex(feeds, Date.now());

            const isStale = Date.now() - fetchedAt > RT_STALE_MS;
            staleEl.classList.remove('hidden', 'stale');
            if (isStale) staleEl.classList.add('stale');
            document.getElementById('staleness-label').textContent = isStale ? 'Stale' : 'Live';

            if (lastStation && !popup.classList.contains('hidden')) {
                showPopup(popup, lastStation, routeMap, getArrivals(lastStation),
                    (routeId) => highlightLine(lineMeshes, routeId));
            }
        } catch {
            staleEl.classList.remove('hidden');
            staleEl.classList.add('stale');
            document.getElementById('staleness-label').textContent = 'Offline';
        }
    }

    refreshRT();
    setInterval(refreshRT, RT_REFRESH_MS);

    buildSearch(stations, document.getElementById('search-bar'), (station) => {
        lastStation = station;
        const { x, z } = geoToXZ(station.lat, station.lng);
        tweenTo(camera, controls, [x, 15, z + 10], [x, 0, z]);
        showPopup(popup, station, routeMap, getArrivals(station),
            (routeId) => highlightLine(lineMeshes, routeId));
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
            lastStation = station;
            const { x, z } = geoToXZ(station.lat, station.lng);
            tweenTo(camera, controls, [x, 15, z + 10], [x, 0, z]);
            showPopup(popup, station, routeMap, getArrivals(station),
                (routeId) => highlightLine(lineMeshes, routeId));
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
