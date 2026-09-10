// src/main.js
// Application entry point. Wires every module together:
// GTFS data → Maplibre map + Three.js custom layer → UI controls → RT refresh loop.
// No business logic lives here — only coordination.

import 'maplibre-gl/dist/maplibre-gl.css';
import { createMap, createThreeLayer, addStationLayer, setStationAlerts, addRouteLines, applyBasemapRestraint, TUBE_ZOOM } from './scene/renderer.js';
import { addEntranceLayer, setEntrancesFor } from './scene/entrances.js';
import { buildLineMeshes, setLineVisibility, highlightLine, clearLineHighlight } from './scene/lines.js';
import { buildSimulatedTrains, tickTrains, buildStationTByRoute, syncRealTrains, countRoutesPerStation } from './scene/trains.js';
import { flyToStation, toggleView, currentOverride, attachAutoPitch } from './ui/camera.js';
import { buildLinesPanel } from './ui/lines-panel.js';
import { buildPopup, showPopup, showPopupLoading, hidePopup, setStationNames } from './ui/popup.js';
import { buildSearch } from './ui/search.js';
import { buildAlertsPanel } from './ui/alerts-panel.js';
import { loadAndParseGTFS, loadStationMeta, loadEntrances, usingEmbeddedData, showEmbeddedDataWarning } from './core/gtfs-loader.js';
import { buildStationComplexes } from './core/gtfs-parser.js';
import { buildCorridors, offsetPoints } from './core/corridors.js';
import { complexIdIndex } from './core/station-meta.js';
import { fetchVehicles, fetchArrivals, fetchAlerts } from './core/rt-loader.js';
import { mergeArrivalResults } from './core/arrivals.js';
import { alertedStationIds } from './core/station-alerts.js';
import { inject as injectAnalytics } from '@vercel/analytics';

const RT_REFRESH_MS = 30_000;
const RT_STALE_MS   = 90_000;

// Spacing between parallel strands in the 3D view, in meters. Twice the tube
// radius, so tubes sit edge to edge the way the flat strands do rather than
// leaving gaps between them.
//
// Not physically truthful, and cannot be: the tubes are already 12 m across
// where a real track is about 4, so honest spacing would just interpenetrate
// them. Consistency with the tube radius is the real constraint. Measured safe
// up to about 16 m — beyond that it starts costing station matches against
// STATION_MATCH_RADIUS_M.
const STRAND_SPACING_M = 12;

// Bootstraps the entire application. Startup is ordered so nothing waits on a
// dependency it doesn't actually have: the map begins fetching tiles before the
// GTFS download starts, and the search / filter / popup UI renders as soon as
// GTFS resolves rather than waiting for the map's tiles to finish arriving.
// Only the 3D scene itself is gated on the map's 'load' event.
async function init() {
    // Page-view analytics. Cookieless, and a no-op outside Vercel deployments,
    // so local development is unaffected. Fired before the awaits below because
    // it is fire-and-forget: a visitor who leaves during the GTFS download
    // still counts, which matters when the number being measured is traffic.
    injectAnalytics();

    // Created first so Maplibre's tile requests overlap the GTFS download below
    // rather than queueing behind it.
    const map = createMap(document.getElementById('map'));
    const threeLayer = createThreeLayer('subway-3d');
    const mapLoaded = new Promise(resolve => map.on('load', resolve));

    // Fetched together: both files are small and independent of the GTFS
    // parse, and serialising them behind it would delay the UI for data that
    // only labels tabs and marks entrances.
    const [{ stations, routeMap, lineRoutes }, stationMeta, entrancesByComplex] = await Promise.all([
        loadAndParseGTFS(),
        loadStationMeta(),
        loadEntrances(),
    ]);

    // Arrivals name their destination by GTFS id; the popup needs a name.
    setStationNames(new Map(stations.map(s => [s.id, s.name])));

    // Grouped by MTA's complex id, not by station name. Name grouping merged
    // the six separate "86 St" stations — 21.8 km apart — into one, which made
    // the popup show a rider on the Upper West Side trains departing Bay Ridge.
    const complexOf = complexIdIndex(stationMeta);
    const complexes = buildStationComplexes(stations, complexOf);
    // Fast stationId → sibling IDs lookup derived from complexes
    const stationGroups = new Map();
    for (const c of complexes) {
        for (const id of c.stationIds) stationGroups.set(id, c.stationIds);
    }

    // Attaches a station's complex siblings. Every entry point runs a station
    // through this before it is stored, because a station that reaches the
    // popup knowing only its own id loses the other platforms' metadata: the
    // direction labels for the 7 and the shuttle at Times Sq live on records
    // the 1/2/3 id has never heard of. A map click already carries the full
    // set; search and the alerts panel do not.
    const withComplex = (station) => station.stationIds
        ? station
        : { ...station, stationIds: stationGroups.get(station.id) ?? [station.id] };

    // Entrances belong to the complex, so a station opened from search and the
    // same station clicked on the map resolve to the same set. A station with
    // no entrance data simply clears the layer rather than leaving the previous
    // station's dots on screen.
    const showEntrances = (station) => {
        const complexId = station ? complexOf.get(station.id) : null;
        setEntrancesFor(map, complexId ? entrancesByComplex.get(complexId) : null);
    };

    // ── UI — built immediately; none of it depends on the map or the 3D scene ──

    // Assigned once the map loads. Everything that touches line geometry must
    // null-check it, since the UI below is live before the scene exists.
    let lineMeshes = null;
    // Chip toggles made before the meshes exist are recorded here and applied
    // once they do. Storing state rather than queueing events keeps it idempotent.
    const filterState = new Map();

    // RT state — shared between the refresh loop and click/search handlers.
    let lastStation = null;
    // Surfaced alerts, for the station rings and the popup's disruption band.
    // Starts empty so a popup opened before the first response simply shows no
    // alerts rather than waiting on one.
    let alerts = [];

    if (usingEmbeddedData) showEmbeddedDataWarning(document.getElementById('ui'));

    // Alerts are independent of the map and the 3D scene, so the panel is built
    // with the rest of the UI rather than behind the map-load gate. It fetches
    // nothing until opened, beyond a single summary call to set its status dot.
    const statusButton = document.getElementById('btn-status');
    buildAlertsPanel(
        document.getElementById('ui'), routeMap, stations, statusButton,
        // Tapping an affected station closes the panel and takes the map there.
        // Routed through the hash so the URL and the panel stay in agreement,
        // and lastStation is set first so openStationPopup's race guard holds.
        (station) => {
            window.location.hash = '';
            lastStation = withComplex(station);
            showEntrances(lastStation);
            flyToStation(map, lastStation);
            openStationPopup(lastStation);
        },
    );
    statusButton.addEventListener('click', () => {
        // Route through the hash so the panel, the URL and the back button stay
        // in agreement; the panel itself listens for the change.
        window.location.hash = window.location.hash === '#alerts' ? '' : 'alerts';
    });

    const popup = buildPopup(document.getElementById('ui'));
    popup.querySelector('.popup-close').addEventListener('click', () => {
        hidePopup(popup);
        if (lineMeshes) clearLineHighlight(lineMeshes);
        setEntrancesFor(map, null);
        lastStation = null;
    });

    const highlight = (routeId) => {
        if (lineMeshes) highlightLine(lineMeshes, routeId);
    };

    buildLinesPanel(
        document.getElementById('ui'), routeMap, document.getElementById('btn-lines'),
        (routeId, active) => {
            filterState.set(routeId, active);
            if (lineMeshes) setLineVisibility(lineMeshes, map, routeId, active);
        },
    );

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
        showPopupLoading(popup, station, routeMap, alerts);
        const result = await getArrivals(station);
        if (lastStation !== station || popup.classList.contains('hidden')) return;
        // Retry re-runs this same function, so it re-enters the loading state
        // and re-applies the race guard above. Manual rather than automatic:
        // refreshRT already retries every 30s, and looping against an API that
        // is genuinely down helps nobody.
        showPopup(popup, station, routeMap, result, highlight,
            () => openStationPopup(station), alerts, stationMeta);
    }

    buildSearch(stations, document.getElementById('search-bar'), (station) => {
        lastStation = withComplex(station);
        showEntrances(lastStation);
        flyToStation(map, lastStation);
        openStationPopup(lastStation);
    });

    // ── 3D scene — the only work that genuinely needs the map's style loaded ──

    await mapLoaded;

    map.addLayer(threeLayer);

    // Where routes share a right-of-way, so each gets its own strand instead of
    // stacking on one polyline. Both representations need it, and they need it
    // in different units: the flat layer offsets in pixels via line-offset, so
    // the ribbon holds its width on screen at overview zoom, while the tubes are
    // real geometry and have to be displaced in meters. Hence two coordinate
    // sets from one corridor index.
    const corridors = buildCorridors(lineRoutes);
    const offsetRoutes = Object.fromEntries(
        Object.entries(lineRoutes).map(([id, coords]) =>
            [id, offsetPoints(coords, corridors.get(id), STRAND_SPACING_M)]),
    );

    const { lineMeshes: meshes, lineCurves } = buildLineMeshes(offsetRoutes, routeMap, threeLayer.scene);
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

    // The overview representation. Added after the station layers so it can be
    // inserted beneath them, and after the tubes exist so the two swap cleanly.
    addRouteLines(map, lineRoutes, routeMap, corridors);

    // Empty until a station is selected; added here so the layer exists before
    // any click can reach it.
    addEntranceLayer(map);
    applyBasemapRestraint(map);

    // Maplibre hides the flat layer by its own maxzoom; the tubes are Three.js
    // objects it knows nothing about, so their half of the swap is manual. Both
    // read TUBE_ZOOM so the two halves cannot drift apart.
    const syncRouteRepresentation = () => {
        const showTubes = map.getZoom() >= TUBE_ZOOM;
        for (const [routeId, mesh] of lineMeshes) {
            // A route the reader has filtered out stays hidden at every zoom.
            mesh.visible = showTubes && (filterState.get(routeId) ?? true);
        }
        threeLayer.map?.triggerRepaint?.();
    };
    map.on('zoom', syncRouteRepresentation);
    syncRouteRepresentation();

    threeLayer.onTick = (delta) => tickTrains(trainMeshes, delta);

    // Replay any chip toggles made while the meshes were still being built.
    for (const [routeId, active] of filterState) {
        setLineVisibility(lineMeshes, map, routeId, active);
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
                        () => openStationPopup(station), alerts, stationMeta);
                }
            }
        } catch {
            staleEl.classList.remove('hidden');
            staleEl.classList.add('stale');
            document.getElementById('staleness-label').textContent = 'Offline';
        }
    }

    // Alerts drive the station rings and the popup's disruption band. Fetched
    // here rather than inside the alerts panel, which deliberately loads nothing
    // until opened — the rings have to be right before anyone opens anything.
    //
    // Kept off the startup path on purpose: this runs after the map has loaded,
    // so the 4 KB it costs cannot delay time-to-interactive. A failure is
    // silent by design; stale or missing rings are worth far less than the
    // arrivals the same screen is showing, and there is nothing a rider would
    // do about an alerts outage.
    async function refreshAlerts() {
        try {
            const { alerts: fresh } = await fetchAlerts();
            alerts = fresh ?? [];
            setStationAlerts(map, alertedStationIds(alerts));
        } catch {
            // Keep the last known alerts rather than clearing the rings: a
            // dropped request is not evidence that service was restored.
        }
    }

    refreshRT();
    refreshAlerts();
    setInterval(refreshRT, RT_REFRESH_MS);
    setInterval(refreshAlerts, RT_REFRESH_MS);

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
        showEntrances(lastStation);
        flyToStation(map, lastStation);
        openStationPopup(lastStation);
    });

    for (const layer of STATION_LAYERS) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }

    // The buttons no longer set pitch directly — pitch follows zoom. Each is now
    // a sticky override the reader can release by pressing it again, because
    // automatic behaviour with no way out is worse than a button.
    const btn2d = document.getElementById('btn-2d');
    const btn3d = document.getElementById('btn-3d');
    const syncViewButtons = () => {
        const mode = currentOverride();
        btn2d.setAttribute('aria-pressed', String(mode === '2d'));
        btn3d.setAttribute('aria-pressed', String(mode === '3d'));
        btn2d.classList.toggle('view-btn--active', mode === '2d');
        btn3d.classList.toggle('view-btn--active', mode === '3d');
    };
    btn2d.addEventListener('click', () => { toggleView(map, '2d'); syncViewButtons(); });
    btn3d.addEventListener('click', () => { toggleView(map, '3d'); syncViewButtons(); });
    syncViewButtons();

    // Pitch follows zoom from here on. There is no opening tilt animation any
    // more: the app opens at the overview zoom, where flat is the correct
    // camera, so the tilt now happens when the reader zooms in.
    attachAutoPitch(map);
}

init();
