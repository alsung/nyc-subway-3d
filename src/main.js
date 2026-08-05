// src/main.js
// Application entry point. Wires every module together:
// GTFS data → Maplibre map + Three.js custom layer → UI controls → RT refresh loop.
// No business logic lives here — only coordination.

import 'maplibre-gl/dist/maplibre-gl.css';
import { createMap, createThreeLayer, addStationLayer } from './scene/renderer.js';
import { buildLineMeshes, setLineVisibility, highlightLine, clearLineHighlight } from './scene/lines.js';
import { buildSimulatedTrains, tickTrains, buildStationTByRoute, syncRealTrains, countRoutesPerStation } from './scene/trains.js';
import { flyToStation, setView } from './ui/camera.js';
import { buildFilterChips } from './ui/filter.js';
import { buildPopup, showPopup, showPopupLoading, hidePopup } from './ui/popup.js';
import { buildSearch } from './ui/search.js';
import { loadAndParseGTFS } from './core/gtfs-loader.js';
import { buildStationComplexes } from './core/gtfs-parser.js';
import { fetchVehicles, fetchArrivals } from './core/rt-loader.js';

const RT_REFRESH_MS = 30_000;
const RT_STALE_MS   = 90_000;

// Bootstraps the entire application. Async because GTFS loading is async;
// the rest of the setup runs once the map's style has finished loading.
async function init() {
    const { stations, routeMap, lineRoutes } = await loadAndParseGTFS();

    const complexes = buildStationComplexes(stations);
    // Fast stationId → sibling IDs lookup derived from complexes
    const stationGroups = new Map();
    for (const c of complexes) {
        for (const id of c.stationIds) stationGroups.set(id, c.stationIds);
    }

    const map = createMap(document.getElementById('map'));
    const threeLayer = createThreeLayer('subway-3d');

    map.on('load', () => {
        map.addLayer(threeLayer);

        const { lineMeshes, lineCurves } = buildLineMeshes(lineRoutes, routeMap, threeLayer.scene);
        const stationTByRoute = buildStationTByRoute(lineCurves, stations);
        const routeCounts = countRoutesPerStation(stationTByRoute);
        const trainMeshes = buildSimulatedTrains(lineCurves, routeMap, threeLayer.scene);

        // Sum constituent station route counts for each complex to determine LOD
        const complexRouteCounts = new Map();
        for (const c of complexes) {
            const total = c.stationIds.reduce((sum, id) => sum + (routeCounts.get(id) ?? 1), 0);
            complexRouteCounts.set(c.stationIds[0], total);
        }

        addStationLayer(map, complexes, stations, complexRouteCounts, routeCounts);

        threeLayer.onTick = (delta) => tickTrains(trainMeshes, delta);

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
        let lastStation = null;

        const highlight = (routeId) => highlightLine(lineMeshes, routeId);

        // Fetches arrivals for a station on demand (Phase 5 lazy per-station fetch).
        // A station may be a raw GTFS station (from search) or an enriched click
        // object with stationIds already resolved; a station complex spans several
        // GTFS IDs, so we fetch each in parallel and merge, deduped by tripId. Failed
        // fetches are skipped. Returns a sorted array, or null when there are none.
        async function getArrivals(station) {
            const ids = station.stationIds ?? stationGroups.get(station.id) ?? [station.id];
            const results = await Promise.all(
                ids.map(id => fetchArrivals(id).then(r => r.arrivals).catch(() => []))
            );
            const seen = new Set();
            const merged = [];
            for (const arrivals of results) {
                for (const a of arrivals) {
                    if (!seen.has(a.tripId)) { seen.add(a.tripId); merged.push(a); }
                }
            }
            merged.sort((a, b) => a.minutes - b.minutes);
            return merged.length ? merged : null;
        }

        // Opens a station popup: shows it immediately in a loading state, then fills
        // in arrivals when the fetch resolves — unless a different station was
        // selected (or the popup closed) in the meantime.
        async function openStationPopup(station) {
            showPopupLoading(popup, station);
            const arrivals = await getArrivals(station);
            if (lastStation !== station || popup.classList.contains('hidden')) return;
            showPopup(popup, station, routeMap, arrivals, highlight);
        }

        // Fetches fresh vehicle data from the API, syncs the 3D trains, updates the
        // staleness indicator (driven by the server's last-refresh time), and quietly
        // re-fetches arrivals for the popup if it's currently open.
        async function refreshRT() {
            const staleEl = document.getElementById('staleness');
            try {
                const { vehicles, updatedAt } = await fetchVehicles();
                syncRealTrains(trainMeshes, vehicles, lineCurves, stationTByRoute, routeMap, threeLayer.scene);

                const serverTime = updatedAt ? Date.parse(updatedAt) : NaN;
                const isStale = Number.isNaN(serverTime) || Date.now() - serverTime > RT_STALE_MS;
                staleEl.classList.remove('hidden', 'stale');
                if (isStale) staleEl.classList.add('stale');
                document.getElementById('staleness-label').textContent = isStale ? 'Stale' : 'Live';

                if (lastStation && !popup.classList.contains('hidden')) {
                    const arrivals = await getArrivals(lastStation);
                    if (lastStation && !popup.classList.contains('hidden')) {
                        showPopup(popup, lastStation, routeMap, arrivals, highlight);
                    }
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
            openStationPopup(station);
        });

        // All four circle layers — complexes (low zoom) and individuals (high zoom).
        // Both store stationIds as a pipe-separated string so this handler is uniform.
        const STATION_LAYERS = [
            'station-complexes-major', 'station-complexes-minor',
            'station-circles-major',   'station-circles-minor',
        ];

        map.on('click', (e) => {
            const features = map.queryRenderedFeatures(e.point, { layers: STATION_LAYERS });
            if (!features.length) return;
            const feat = features[0];
            const ids = feat.properties.stationIds.split('|');
            if (!stations.find(s => s.id === ids[0])) return;
            lastStation = {
                id: ids[0],
                name: feat.properties.name,
                lat: feat.geometry.coordinates[1],
                lng: feat.geometry.coordinates[0],
                stationIds: ids,
            };
            flyToStation(map, lastStation);
            openStationPopup(lastStation);
        });

        for (const layer of STATION_LAYERS) {
            map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
        }

        document.getElementById('btn-2d').addEventListener('click', () => setView(map, '2d'));
        document.getElementById('btn-3d').addEventListener('click', () => setView(map, '3d'));
    });
}

init();
