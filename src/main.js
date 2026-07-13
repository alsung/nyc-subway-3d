// src/main.js
// Application entry point. Wires every module together:
// GTFS data → Maplibre map + Three.js custom layer → UI controls → RT refresh loop.
// No business logic lives here — only coordination.

import 'maplibre-gl/dist/maplibre-gl.css';
import { createMap, createThreeLayer, addStationLabels } from './scene/renderer.js';
import { buildLineMeshes, setLineVisibility, highlightLine, clearLineHighlight } from './scene/lines.js';
import { buildStationMeshes, getStationAt } from './scene/stations.js';
import { buildSimulatedTrains, tickTrains, buildStationTByRoute, syncRealTrains, countRoutesPerStation } from './scene/trains.js';
import { flyToStation, setView } from './ui/camera.js';
import { buildFilterChips } from './ui/filter.js';
import { buildPopup, showPopup, hidePopup } from './ui/popup.js';
import { buildSearch } from './ui/search.js';
import { loadAndParseGTFS } from './core/gtfs-loader.js';
import { loadRT } from './core/rt-loader.js';
import { buildArrivalIndex, parseVehiclePositions } from './core/rt-parser.js';

const RT_REFRESH_MS = 30_000;
const RT_STALE_MS   = 90_000;

// Stations served by fewer than this many routes are hidden below LOD_ZOOM,
// keeping borough-wide views from looking cluttered with minor stops.
const MAJOR_ROUTE_THRESHOLD = 3;
const LOD_ZOOM = 13;

// Bootstraps the entire application. Async because GTFS loading is async;
// the rest of the setup runs once the map's style has finished loading.
async function init() {
    const { stations, routeMap, lineRoutes } = await loadAndParseGTFS();

    const map = createMap(document.getElementById('map'));
    const threeLayer = createThreeLayer('subway-3d');

    map.on('load', () => {
        map.addLayer(threeLayer);

        addStationLabels(map, stations);

        const { lineMeshes, lineCurves } = buildLineMeshes(lineRoutes, routeMap, threeLayer.scene);
        const stationTByRoute = buildStationTByRoute(lineCurves, stations);
        const routeCounts = countRoutesPerStation(stationTByRoute);
        const stationMeshes = buildStationMeshes(stations, threeLayer.scene, routeCounts);
        const trainMeshes = buildSimulatedTrains(lineCurves, routeMap, threeLayer.scene);

        threeLayer.onTick = (delta) => tickTrains(trainMeshes, delta);

        // Hides minor stations (fewer than MAJOR_ROUTE_THRESHOLD routes) until
        // zoomed in past LOD_ZOOM, so borough-wide views aren't cluttered.
        function applyStationLOD() {
            const showAll = map.getZoom() >= LOD_ZOOM;
            for (const mesh of stationMeshes) {
                mesh.visible = showAll || mesh.userData.routeCount >= MAJOR_ROUTE_THRESHOLD;
            }
        }
        map.on('zoom', applyStationLOD);
        applyStationLOD();

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
                syncRealTrains(trainMeshes, parseVehiclePositions(feeds), lineCurves, stationTByRoute, routeMap, threeLayer.scene);

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
            flyToStation(map, station);
            showPopup(popup, station, routeMap, getArrivals(station),
                (routeId) => highlightLine(lineMeshes, routeId));
        });

        // Clicking a station marker flies the map to it and opens the popup.
        map.on('click', (e) => {
            const station = getStationAt(stations, e.lngLat);
            if (station) {
                lastStation = station;
                flyToStation(map, station);
                showPopup(popup, station, routeMap, getArrivals(station),
                    (routeId) => highlightLine(lineMeshes, routeId));
            }
        });

        document.getElementById('btn-2d').addEventListener('click', () => setView(map, '2d'));
        document.getElementById('btn-3d').addEventListener('click', () => setView(map, '3d'));
    });
}

init();
