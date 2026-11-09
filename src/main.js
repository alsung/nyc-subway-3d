// src/main.js
// Application entry point. Wires every module together:
// GTFS data → Maplibre map → UI controls → RT refresh loop.
// No business logic lives here — only coordination.

import 'maplibre-gl/dist/maplibre-gl.css';
import { createMap, addStationLayer, setStationAlerts, addRouteLines, addTripPathLayer, applyBasemapRestraint } from './scene/renderer.js';
import { addEntranceLayer, setEntrancesFor } from './scene/entrances.js';
import { addPlatformLayer, setPlatformsFor } from './scene/platform-layer.js';
import { setLineVisibility, highlightLine, clearLineHighlight, dimAllLines, showTripPath } from './scene/lines.js';
import { addTrainLayer, buildRouteIndex, createTrainState, syncTrains, setTrainVisibility, setTrainsEnabled, startTrainLoop } from './scene/train-layer.js';
import { flyToStation } from './ui/camera.js';
import { buildLinesPanel } from './ui/lines-panel.js';
import { buildPopup, showPopup, showPopupLoading, hidePopup, setStationNames } from './ui/popup.js';
import { buildSearch } from './ui/search.js';
import { buildTripPlanner } from './ui/trip-planner.js';
import { tripPathFeatures } from './core/trip-path.js';
import { buildAlertsPanel } from './ui/alerts-panel.js';
import { loadAndParseGTFS, loadStationMeta, loadEntrances, usingEmbeddedData, showEmbeddedDataWarning } from './core/gtfs-loader.js';
import { loadPlatforms, loadCarPositions } from './core/rt-loader.js';
import { buildStationComplexes } from './core/gtfs-parser.js';
import { buildCorridors } from './core/corridors.js';
import { complexIdIndex, buildSearchEntries, searchEntryLabel, routeCountByStation } from './core/station-meta.js';
import { fetchVehicles, fetchArrivals, fetchAlerts } from './core/rt-loader.js';
import { mergeArrivalResults } from './core/arrivals.js';
import { alertedStationIds } from './core/station-alerts.js';
import { readPref, writePref } from './core/prefs.js';
import { tryRestoreSession } from './core/auth.js';
import { loadFeatures } from './core/features.js';
import { loadCommutes } from './core/commutes.js';
import { stationPath, parseStationPath, parseLinePath, lineRouteIds } from './core/slugs.js';
import { buildLineChip, lineName } from './ui/line-chip.js';
import { buildAuthButton } from './ui/auth-button.js';
import { buildAuthModal } from './ui/auth-modal.js';
import { buildSettingsModal } from './ui/settings-modal.js';
import { inject as injectAnalytics } from '@vercel/analytics';

const RT_REFRESH_MS = 30_000;
const RT_STALE_MS   = 90_000;

// Bootstraps the entire application. Startup is ordered so nothing waits on a
// dependency it doesn't actually have: the map begins fetching tiles before the
// GTFS download starts, and the search / filter / popup UI renders as soon as
// GTFS resolves rather than waiting for the map's tiles to finish arriving.
// Only the map layers themselves are gated on the map's 'load' event.
function showFatalError() {
    const el = document.createElement('div');
    el.id = 'fatal-error';
    el.innerHTML = `
        <p>Something went wrong loading the map.</p>
        <button onclick="location.reload()">Reload</button>
    `;
    document.body.appendChild(el);
}

const MAP_LOAD_TIMEOUT_MS = 20_000;

async function init() {
    const path = window.location.pathname;
    if (path === '/verify') {
        const { renderVerifyPage } = await import('./ui/verify-page.js');
        return renderVerifyPage();
    }
    if (path === '/reset-password') {
        const { renderResetPasswordPage } = await import('./ui/reset-password-page.js');
        return renderResetPasswordPage();
    }

    // Page-view analytics. Cookieless, and a no-op outside Vercel deployments,
    // so local development is unaffected. Fired before the awaits below because
    // it is fire-and-forget: a visitor who leaves during the GTFS download
    // still counts, which matters when the number being measured is traffic.
    injectAnalytics();

    // Restore a previous session from the stored refresh token and load feature
    // flags. Both are fire-and-forget: a failed restore means anonymous usage,
    // and a failed feature load means hasFeature returns false for everything.
    tryRestoreSession().then(loadFeatures).then(loadCommutes).catch(() => {});

    // Created first so Maplibre's tile requests overlap the GTFS download below
    // rather than queueing behind it.
    const map = createMap(document.getElementById('map'));
    const mapLoaded = Promise.race([
        new Promise(resolve => map.on('load', resolve)),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Map style timed out')), MAP_LOAD_TIMEOUT_MS)),
    ]);

    // Fetched together: both files are small and independent of the GTFS
    // parse, and serialising them behind it would delay the UI for data that
    // only labels tabs and marks entrances.
    const [{ stations, routeMap, lineRoutes }, stationMeta, entrancesByComplex, platformsByComplex, carPositions] = await Promise.all([
        loadAndParseGTFS(),
        loadStationMeta(),
        loadEntrances(),
        loadPlatforms(),
        loadCarPositions(),
    ]);

    // Arrivals name their destination by GTFS id; the popup needs a name.
    setStationNames(new Map(stations.map(s => [s.id, s.name])));

    // Grouped by MTA's complex id, not by station name. Name grouping merged
    // the six separate "86 St" stations — 21.8 km apart — into one, which made
    // the popup show a rider on the Upper West Side trains departing Bay Ridge.
    const complexOf = complexIdIndex(stationMeta);
    const complexes = buildStationComplexes(stations, complexOf);

    // Search lists complexes, not the 496 GTFS stations: four of those are
    // named "Times Sq-42 St", one per platform group. Each entry carries the
    // lines it serves and its borough, because 55 names are still duplicated
    // after collapsing and borough alone resolves only nine of them.
    const searchEntries = buildSearchEntries(complexes, stationMeta);

    // For /station/<complex id> URLs, in both directions.
    const complexById = new Map(complexes
        .filter(c => c.complexId)
        .map(c => [String(c.complexId), c]));
    const complexOfStation = (station) => {
        const id = station ? complexOf.get(station.id) : null;
        return id ? complexById.get(String(id)) : undefined;
    };
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
    const stationById = new Map(stations.map(st => [st.id, st]));

    const showEntrances = (station) => {
        const complexId = station ? complexOf.get(station.id) : null;
        setEntrancesFor(map, complexId ? entrancesByComplex.get(complexId) : null);
        setPlatformsFor(map, complexId ? platformsByComplex.get(complexId) : null);
    };

    // ── UI — built immediately; none of it depends on the map's layers ──

    // Assigned once the map loads. Everything that touches trains must
    // null-check it, since the UI below is live before the layers exist.
    let trainState = null;
    // Whether the route layer exists yet. The line helpers are no-ops without
    // it, but the filter state still has to be replayed once it does.
    let layersReady = false;
    // Where routes share track, from buildCorridors once the map loads. The
    // trip path needs it to sit on each route's strand.
    let corridors = null;
    // Chip toggles made before the layers exist are recorded here and applied
    // once they do. Storing state rather than queueing events keeps it idempotent.
    const filterState = new Map();

    // Whether live trains are drawn. Remembered across visits: a reader who
    // turned them off wanted a quieter map, and making them turn it off again
    // every visit would be its own kind of noise. Defaults on — the live network
    // is the thing this map is for.
    let trainsOn = readPref('trains', true) !== false;

    // RT state — shared between the refresh loop and click/search handlers.
    let lastStation = null;
    // Surfaced alerts, for the station rings and the popup's disruption band.
    // Starts empty so a popup opened before the first response simply shows no
    // alerts rather than waiting on one.
    let alerts = [];
    let consecutiveFailures = 0;

    if (usingEmbeddedData) showEmbeddedDataWarning(document.getElementById('ui'));

    // Alerts are independent of the map and the 3D scene, so the panel is built
    // with the rest of the UI rather than behind the map-load gate. It fetches
    // nothing until opened, beyond a single summary call to set its status dot.
    const statusButton = document.getElementById('btn-status');
    buildAlertsPanel(
        document.getElementById('ui'), routeMap, stations, statusButton,
        // Tapping an affected station closes the panel and takes the map there.
        // Routed through the hash so the URL and the panel stay in agreement.
        (station) => {
            window.location.hash = '';
            openStation(station);
        },
    );
    statusButton.addEventListener('click', () => {
        // Route through the hash so the panel, the URL and the back button stay
        // in agreement; the panel itself listens for the change.
        window.location.hash = window.location.hash === '#alerts' ? '' : 'alerts';
    });

    const popup = buildPopup(document.getElementById('ui'));

    // ── Station and line URLs (#117) ──
    //
    // An open station is /station/611-times-sq-42-st and a highlighted line is
    // /line/g, so either can be linked, shared and indexed. The query string
    // and the #lines / #alerts hash are carried through every change, so the
    // hash panels keep working on top of either.

    const BASE_TITLE = document.title;
    const allRouteIds = Object.keys(routeMap);
    // The line a /line URL is showing, or null.
    let activeLine = null;
    // The trip planner's open itinerary, or null.
    let activeTrip = null;

    // Marks a history entry this page pushed for a station. Closing the popup
    // steps back over a marked entry; on any other (a link the visitor arrived
    // on, or a #alerts / #lines entry the hash panels added) it replaces the
    // URL instead. Kept on the entry rather than in a variable because the
    // browser restores it on Forward, and because hash changes add entries of
    // their own between ours and the current one.
    const PUSHED = { localExpress: 'station' };
    const isPushedEntry = () => history.state?.localExpress === PUSHED.localExpress;

    // A replace keeps the entry's state, so a second station opened over a
    // pushed one is still stepped back over in one press.
    const setPath = (path, mode) => {
        const url = `${path}${window.location.search}${window.location.hash}`;
        if (mode === 'push') history.pushState(PUSHED, '', url);
        else history.replaceState(history.state, '', url);
    };
    // Back to the bare map. Clears the mark, since the entry is no longer a
    // station of ours.
    const replaceWithHome = () => {
        history.replaceState(null, '', `/${window.location.search}${window.location.hash}`);
    };

    // Sets the route dimming from what is on screen: an open trip dims every
    // route under its own path, a line view dims all but its line, and
    // otherwise nothing is dimmed. Re-run after anything changes the dimming
    // (a popup's route bullet), so the trip and the line view outlast it.
    const applyHighlight = () => {
        if (activeTrip) dimAllLines(map);
        else if (activeLine) highlightLine(map, lineRouteIds(activeLine, allRouteIds));
        else clearLineHighlight(map);
    };

    // Draws the open trip's ridden stretches and walks, or clears them. Waits
    // for the layers, and runs again once they exist.
    const drawTrip = () => {
        if (!layersReady) return;
        showTripPath(map, activeTrip
            ? tripPathFeatures(activeTrip, { lineRoutes, corridors, stationById, routeMap })
            : []);
        applyHighlight();
    };

    const fitLine = () => {
        const coords = lineRouteIds(activeLine, allRouteIds)
            .flatMap(id => (lineRoutes[id] ?? []).flat());
        if (coords.length < 2) return;
        const lats = coords.map(c => c[0]);
        const lngs = coords.map(c => c[1]);
        map.fitBounds(
            [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
            // A short line (the 42 St Shuttle is under a kilometer) would
            // otherwise zoom to street level and lose where it is.
            { padding: 80, maxZoom: 15, duration: 900 },
        );
    };

    const showLine = (routeId) => {
        if (activeLine === routeId) return;
        activeLine = routeId;
        lineChip.show(routeId);
        applyHighlight();
        fitLine();
        document.title = `${lineName(routeId, routeMap)} · Local Express`;
    };

    const clearLine = () => {
        if (!activeLine) return;
        activeLine = null;
        lineChip.hide();
        applyHighlight();
        document.title = BASE_TITLE;
    };

    const lineChip = buildLineChip(document.getElementById('ui'), routeMap, () => {
        clearLine();
        if (parseLinePath(window.location.pathname, allRouteIds)) replaceWithHome();
    });

    // Every way into a station goes through here: a map click, search, the
    // alerts panel and a /station URL. lastStation is set before the popup
    // opens so openStationPopup's race guard holds.
    //
    // history: 'push' adds an entry, so Back closes the popup. Picking a second
    // station while one is open replaces that entry instead, so Back still
    // closes the popup in one press. 'none' is for syncing from the URL, which
    // is already right.
    function openStation(station, { history: mode = 'push' } = {}) {
        const wasOpen = lastStation !== null && !popup.classList.contains('hidden');
        clearLine();
        lastStation = withComplex(station);
        showEntrances(lastStation);
        flyToStation(map, lastStation);
        openStationPopup(lastStation);

        const complex = complexOfStation(lastStation);
        document.title = `${complex?.name ?? lastStation.name} · Local Express`;
        const path = complex ? stationPath(complex) : null;
        if (!path || mode === 'none' || window.location.pathname === path) return;
        setPath(path, mode === 'push' && !wasOpen ? 'push' : 'replace');
    }

    // Closes the popup without touching the URL, for when the URL already
    // moved on (the Back button).
    const closeStation = () => {
        hidePopup(popup);
        setEntrancesFor(map, null);
        setPlatformsFor(map, null);
        lastStation = null;
        document.title = BASE_TITLE;
        applyHighlight();
    };

    const dismissPopup = () => {
        const wasOpen = lastStation !== null;
        closeStation();
        if (wasOpen && parseStationPath(window.location.pathname)) {
            if (isPushedEntry()) history.back();
            else replaceWithHome();
        }
    };

    // Brings the page into line with the address bar: on first load, and on
    // Back and Forward.
    const syncFromUrl = () => {
        const path = window.location.pathname;
        const complexId = parseStationPath(path);
        if (complexId) {
            const complex = complexById.get(complexId);
            if (!complex) {
                // A station id that does not exist. Real 404s are #119.
                if (lastStation) closeStation();
                replaceWithHome();
                return;
            }
            if (complexOfStation(lastStation) !== complex) {
                openStation({
                    id: complex.stationIds[0], name: complex.name,
                    lat: complex.lat, lng: complex.lng, stationIds: complex.stationIds,
                }, { history: 'none' });
            }
            // A link with an old or trimmed name still opens; the address bar
            // is corrected to the current name.
            const canonical = stationPath(complex);
            if (path !== canonical) setPath(canonical, 'replace');
            return;
        }

        if (lastStation) closeStation();

        const routeId = parseLinePath(path, allRouteIds);
        if (routeId) showLine(routeId);
        else {
            clearLine();
            if (path.startsWith('/line/')) replaceWithHome();
        }
    };
    window.addEventListener('popstate', syncFromUrl);

    popup.querySelector('.popup-close').addEventListener('click', dismissPopup);

    // Escape closes the popup, as it already does for the lines panel, the
    // alerts panel and the search results. The popup was the only dismissible
    // surface that ignored it.
    //
    // Anything else that Escape closes takes the key first: one press closes
    // one thing. Every other Escape handler calls preventDefault when it closes
    // something, and this one listens on window, which the key reaches after
    // every listener on the document. That replaced a list here of the panels
    // allowed to go first, which the trip panel and the modals were missing
    // (#145).
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented || popup.classList.contains('hidden')) return;
        dismissPopup();
    });

    const highlight = (routeId) => {
        highlightLine(map, routeId);
    };

    buildLinesPanel(
        document.getElementById('ui'), routeMap, document.getElementById('btn-lines'),
        (routeId, active) => {
            filterState.set(routeId, active);
            if (!layersReady) return;
            setLineVisibility(map, routeId, active);
            // Trains follow their route: a filtered-out line whose trains kept
            // running would be the same half-applied filter the two-representation
            // split used to produce.
            if (trainState) setTrainVisibility(trainState, routeId, active);
        },
        {
            trainsOn,
            onTrainsToggle: (on) => {
                trainsOn = on;
                writePref('trains', on);
                if (trainState) setTrainsEnabled(trainState, on);
            },
        },
    );

    const authModal = buildAuthModal(document.getElementById('auth-modal'));
    const settingsModal = buildSettingsModal(document.getElementById('settings-modal'));
    buildAuthButton(document.getElementById('app-footer'), authModal.open, settingsModal);

    buildTripPlanner(
        document.getElementById('ui'), searchEntries, stations, routeMap,
        document.getElementById('btn-trip'),
        { carPositions, complexOf, stationById },
        {
            onPlan: (journey) => {
                activeTrip = journey;
                drawTrip();

                const coords = journey.legs
                    .flatMap(leg => leg.stops ?? [leg.fromStop, leg.toStop])
                    .map(id => stationById.get(String(id).replace(/[NS]$/, '')))
                    .filter(Boolean)
                    .map(st => [st.lng, st.lat]);
                if (coords.length < 2) return;

                const lngs = coords.map(c => c[0]);
                const lats = coords.map(c => c[1]);
                map.fitBounds(
                    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
                    { padding: { top: 80, bottom: 80, left: 420, right: 80 }, duration: 900 },
                );
            },
            onClear: () => {
                activeTrip = null;
                drawTrip();
            },
        },
        authModal,
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

    buildSearch(
        searchEntries, document.getElementById('search-bar'),
        (station) => openStation(station),
        { routeMap, labelFor: searchEntryLabel },
    );

    // A /station or /line link opens straight away, before the map's tiles
    // arrive. The entrance dots and the line highlight catch up once the
    // layers exist, below.
    syncFromUrl();

    // ── Map layers — the only work that genuinely needs the map's style loaded ──

    await mapLoaded;

    // Where routes share a right-of-way, so each gets its own strand instead of
    // stacking on one polyline. The layer offsets in pixels via line-offset, so
    // the ribbon holds its width on screen at every zoom rather than spreading
    // as you approach.
    corridors = buildCorridors(lineRoutes);

    // Station level-of-detail, straight from the dataset. It used to be counted
    // off the route curves, which meant sampling every route to rediscover what
    // daytime_routes already says.
    const routeCounts = routeCountByStation(stationMeta);

    // Sum constituent station route counts for each complex to determine LOD
    const complexRouteCounts = new Map();
    for (const c of complexes) {
        const total = c.stationIds.reduce((sum, id) => sum + (routeCounts.get(id) ?? 1), 0);
        complexRouteCounts.set(c.stationIds[0], total);
    }

    addStationLayer(map, complexes, stations, complexRouteCounts, routeCounts);

    // Added after the station layers so it can be inserted beneath them: the
    // dots are the anchor and the lines run behind them.
    addRouteLines(map, lineRoutes, routeMap, corridors);
    addTripPathLayer(map);

    // Empty until a station is selected; added here so the layer exists before
    // any click can reach it.
    addEntranceLayer(map);
    addPlatformLayer(map);
    addTrainLayer(map, routeMap);
    applyBasemapRestraint(map);
    layersReady = true;

    // Where each station falls along each of a route's lines. Built once: a
    // vehicle's position is resolved by stop id against this rather than by
    // searching geometry every time a snapshot lands.
    const routeIndex = buildRouteIndex(lineRoutes, stations);
    trainState = createTrainState(map);
    // Apply a remembered choice before the first snapshot lands, so a reader who
    // turned trains off never sees them flash on during startup.
    setTrainsEnabled(trainState, trainsOn);
    startTrainLoop(trainState);

    // Replay any chip toggles made while the layers were still being built.
    for (const [routeId, active] of filterState) {
        setLineVisibility(map, routeId, active);
        setTrainVisibility(trainState, routeId, active);
    }

    // A station, line or trip opened before the layers existed.
    if (lastStation) showEntrances(lastStation);
    drawTrip();

    // Fetches fresh vehicle data from the API, syncs the trains, updates the
    // staleness indicator (driven by the server's last-refresh time), and quietly
    // re-fetches arrivals for the popup if it's currently open.
    async function refreshRT() {
        const staleEl = document.getElementById('staleness');
        const banner = document.getElementById('connection-banner');
        try {
            const { vehicles, updatedAt } = await fetchVehicles();
            syncTrains(trainState, vehicles, routeIndex);

            const serverTime = updatedAt ? Date.parse(updatedAt) : NaN;
            const isStale = Number.isNaN(serverTime) || Date.now() - serverTime > RT_STALE_MS;
            staleEl.classList.remove('hidden', 'stale');
            if (isStale) staleEl.classList.add('stale');
            document.getElementById('staleness-label').textContent = isStale ? 'Stale' : 'Live';

            if (consecutiveFailures >= 2) banner.classList.add('hidden');
            consecutiveFailures = 0;

            if (lastStation && !popup.classList.contains('hidden')) {
                const station = lastStation;
                const result = await getArrivals(station);
                if (lastStation === station && !popup.classList.contains('hidden')) {
                    showPopup(popup, station, routeMap, result, highlight,
                        () => openStationPopup(station), alerts, stationMeta);
                }
            }
        } catch {
            consecutiveFailures++;
            staleEl.classList.remove('hidden');
            staleEl.classList.add('stale');
            document.getElementById('staleness-label').textContent = 'Offline';
            if (consecutiveFailures >= 2) banner.classList.remove('hidden');
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
        openStation({
            id: ids[0],
            name: feat.properties.name,
            lat: feat.geometry.coordinates[1],
            lng: feat.geometry.coordinates[0],
            stationIds: ids,
        });
    });

    for (const layer of STATION_LAYERS) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
}

// ── Privacy modal ──────────────────────────────────────────────────────────
const privacyModal = document.getElementById('privacy-modal');
document.getElementById('btn-privacy').addEventListener('click', () => {
    privacyModal.classList.remove('hidden');
});
document.getElementById('privacy-backdrop').addEventListener('click', () => {
    privacyModal.classList.add('hidden');
});
document.getElementById('privacy-close').addEventListener('click', () => {
    privacyModal.classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !privacyModal.classList.contains('hidden')) {
        e.preventDefault();
        privacyModal.classList.add('hidden');
    }
});

init().catch((err) => {
    console.error('[init] fatal:', err);
    showFatalError();
});
