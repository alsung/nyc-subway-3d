// src/main.js
// Application entry point. Wires every module together:
// GTFS data → Maplibre map + Three.js custom layer → UI controls → RT refresh loop.
// No business logic lives here — only coordination.

import 'maplibre-gl/dist/maplibre-gl.css';
import { createMap, createThreeLayer, addStationLayer } from './scene/renderer.js';
import { buildLineMeshes, setLineVisibility, highlightLine, clearLineHighlight } from './scene/lines.js';
import { buildSimulatedTrains, tickTrains, buildStationTByRoute, syncRealTrains, countRoutesPerStation } from './scene/trains.js';
import { flyToStation, setView, introToThreeD } from './ui/camera.js';
import { buildFilterChips } from './ui/filter.js';
import { buildPopup, showPopup, showPopupLoading, hidePopup } from './ui/popup.js';
import { buildSearch } from './ui/search.js';
import { buildAlertsPanel } from './ui/alerts-panel.js';
import { loadAndParseGTFS, usingEmbeddedData, showEmbeddedDataWarning } from './core/gtfs-loader.js';
import { buildStationComplexes } from './core/gtfs-parser.js';
import { fetchVehicles, fetchArrivals } from './core/rt-loader.js';
import { mergeArrivalResults } from './core/arrivals.js';

const RT_REFRESH_MS = 30_000;
const RT_STALE_MS   = 90_000;

// Bootstraps the entire application. Startup is ordered so nothing waits on a
// dependency it doesn't actually have: the map begins fetching tiles before the
// GTFS download starts, and the search / filter / popup UI renders as soon as
// GTFS resolves rather than waiting for the map's tiles to finish arriving.
// Only the 3D scene itself is gated on the map's 'load' event.
async function init() {
    // Created first so Maplibre's tile requests overlap the GTFS download below
    // rather than queueing behind it.
    const map = createMap(document.getElementById('map'));
    const threeLayer = createThreeLayer('subway-3d');
    const mapLoaded = new Promise(resolve => map.on('load', resolve));

    // A pan, zoom, or tilt during loading is a deliberate camera choice; the
    // opening animation must not override it. Listening for raw input on the
    // canvas rather than Maplibre's move events keeps this independent of
    // whether a given move was user- or code-initiated.
    let userMovedCamera = false;
    for (const type of ['mousedown', 'touchstart', 'wheel']) {
        map.getCanvas().addEventListener(type, () => { userMovedCamera = true; }, { once: true, passive: true });
    }

    const { stations, routeMap, lineRoutes } = await loadAndParseGTFS();

    const complexes = buildStationComplexes(stations);
    // Fast stationId → sibling IDs lookup derived from complexes
    const stationGroups = new Map();
    for (const c of complexes) {
        for (const id of c.stationIds) stationGroups.set(id, c.stationIds);
    }

    // ── UI — built immediately; none of it depends on the map or the 3D scene ──

    // Assigned once the map loads. Everything that touches line geometry must
    // null-check it, since the UI below is live before the scene exists.
    let lineMeshes = null;
    // Chip toggles made before the meshes exist are recorded here and applied
    // once they do. Storing state rather than queueing events keeps it idempotent.
    const filterState = new Map();

    // RT state — shared between the refresh loop and click/search handlers.
    let lastStation = null;

    if (usingEmbeddedData) showEmbeddedDataWarning(document.getElementById('ui'));

    // Alerts are independent of the map and the 3D scene, so the panel is built
    // with the rest of the UI rather than behind the map-load gate. It fetches
    // nothing until opened, beyond a single summary call to set its status dot.
    const statusButton = document.getElementById('btn-status');
    buildAlertsPanel(document.getElementById('ui'), routeMap, statusButton);
    statusButton.addEventListener('click', () => {
        // Route through the hash so the panel, the URL and the back button stay
        // in agreement; the panel itself listens for the change.
        window.location.hash = window.location.hash === '#alerts' ? '' : 'alerts';
    });

    const popup = buildPopup(document.getElementById('ui'));
    popup.querySelector('.popup-close').addEventListener('click', () => {
        hidePopup(popup);
        if (lineMeshes) clearLineHighlight(lineMeshes);
        lastStation = null;
    });

    const highlight = (routeId) => {
        if (lineMeshes) highlightLine(lineMeshes, routeId);
    };

    buildFilterChips(routeMap, document.getElementById('chip-bar'), (routeId, active) => {
        filterState.set(routeId, active);
        if (lineMeshes) setLineVisibility(lineMeshes, routeId, active);
    });

    // Fetches arrivals for a station on demand (Phase 5 lazy per-station fetch).
    // A station may be a raw GTFS station (from search) or an enriched click
    // object with stationIds already resolved; a station complex spans several
    // GTFS IDs, so we fetch each in parallel and merge, deduped by tripId. Failed
    // fetches are skipped. Returns a sorted array, or null when there are none.
    async function getArrivals(station) {
        const ids = station.stationIds ?? stationGroups.get(station.id) ?? [station.id];
        // allSettled, not all: a rejected request has to stay distinguishable
        // from a station with no service. mergeArrivalResults keeps the outcome.
        const settled = await Promise.allSettled(ids.map(id => fetchArrivals(id)));
        return mergeArrivalResults(settled);
    }

    // Opens a station popup: shows it immediately in a loading state, then fills
    // in arrivals when the fetch resolves — unless a different station was
    // selected (or the popup closed) in the meantime.
    async function openStationPopup(station) {
        showPopupLoading(popup, station);
        const result = await getArrivals(station);
        if (lastStation !== station || popup.classList.contains('hidden')) return;
        // Retry re-runs this same function, so it re-enters the loading state
        // and re-applies the race guard above. Manual rather than automatic:
        // refreshRT already retries every 30s, and looping against an API that
        // is genuinely down helps nobody.
        showPopup(popup, station, routeMap, result, highlight, () => openStationPopup(station));
    }

    buildSearch(stations, document.getElementById('search-bar'), (station) => {
        lastStation = station;
        flyToStation(map, station);
        openStationPopup(station);
    });

    // ── 3D scene — the only work that genuinely needs the map's style loaded ──

    await mapLoaded;

    map.addLayer(threeLayer);

    const { lineMeshes: meshes, lineCurves } = buildLineMeshes(lineRoutes, routeMap, threeLayer.scene);
    lineMeshes = meshes;
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

    // Replay any chip toggles made while the meshes were still being built.
    for (const [routeId, active] of filterState) {
        setLineVisibility(lineMeshes, routeId, active);
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
                // Capture the station: the await below can outlive the user's
                // selection, and re-reading lastStation would let a stale
                // response overwrite a newer station's popup.
                const station = lastStation;
                const result = await getArrivals(station);
                if (lastStation === station && !popup.classList.contains('hidden')) {
                    showPopup(popup, station, routeMap, result, highlight,
                        () => openStationPopup(station));
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

    // The map opens flat to keep the initial tile set small; tilt into the 3D
    // view now that it has loaded. Skipped if the user already moved the camera
    // by hand. A station selected from search is fine — the intro changes pitch
    // and bearing only, and waits for any in-flight flyTo to land.
    if (!userMovedCamera) introToThreeD(map);
}

init();
