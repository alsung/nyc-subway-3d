import { isArrivalsStale, formatAge, splitByDirection, trunksInArrivals } from '../core/arrivals.js';
import { directionLabel, stopIdForTrunk, routeLabelsFor } from '../core/station-meta.js';
import { trunksFor, bulletRoutes } from '../core/trunks.js';
import { dedupeBulletRoutes } from '../core/alert-status.js';
import { alertsForStation } from '../core/station-alerts.js';
import { parseAlertText } from '../core/alert-text.js';
import { routeBullet } from './route-bullet.js';

// How many alerts to show before the popup turns into a wall of text. The
// panel is the place to read all of them; here we are answering "is something
// wrong with this station right now".
const POPUP_ALERT_LIMIT = 2;

// Rows shown before "Show more" appears. Six covers roughly half an hour at a
// busy station, which is as far ahead as a countdown is worth reading.
const VISIBLE_ROWS = 6;

// Which trunk and platform the reader last chose.
//
// Held outside showPopup because the 30-second refresh re-enters it with fresh
// arrivals, and local state would be rebuilt from scratch each time: select the
// 7 at Times Sq, read for half a minute, and the panel would silently throw you
// back to the first trunk. Keyed by station so the selection resets when the
// reader moves somewhere else, where a trunk named "123" means a different
// platform entirely.
let selection = { stationId: null, trunkKey: null, dir: null };

export function buildPopup(container) {
    const popup = document.createElement('div');
    popup.id = 'station-popup';
    popup.classList.add('hidden');
    popup.innerHTML = `
        <button class="popup-close">×</button>
        <div class="popup-name"></div>
        <div class="popup-trunks"></div>
        <div class="popup-alerts hidden"></div>
        <div class="popup-tabs" role="tablist"></div>
        <div class="popup-arrivals"></div>
        <div class="popup-note hidden"></div>
    `;
    container.appendChild(popup);
    return popup;
}

// Fills the disruption band above the arrival columns, and returns how many
// alerts were shown. Hidden entirely when the station is unaffected, so a
// healthy popup looks exactly as it did before.
//
// This is what turns the popup's generic "No trains scheduled" into a reason:
// the alerts that explain an empty station are station-scoped and name it
// directly, so they reach here without needing to know which routes serve it.
function renderAlerts(popup, station, routeMap, alerts, routeIds) {
    const band = popup.querySelector('.popup-alerts');
    band.innerHTML = '';

    const ids = station.stationIds ?? [station.id];
    const matched = alertsForStation(alerts, ids, routeIds);

    if (matched.length === 0) {
        band.classList.add('hidden');
        return 0;
    }

    for (const alert of matched.slice(0, POPUP_ALERT_LIMIT)) {
        const row = document.createElement('div');
        row.className = `popup-alert popup-alert--${alert.kind ?? 'planned'}`;

        if (alert.label) {
            const label = document.createElement('div');
            label.className = 'popup-alert-label';
            label.textContent = alert.label;
            row.appendChild(label);
        }

        const text = document.createElement('div');
        text.className = 'popup-alert-text';
        // Same treatment as the alerts panel: [A] becomes a real bullet and
        // everything else goes in as text. innerHTML is never used — this is
        // third-party copy.
        for (const seg of parseAlertText(alert.header)) {
            if (seg.route !== undefined) {
                const b = routeBullet(seg.route, routeMap);
                b.classList.add('alert-bullet--inline');
                text.appendChild(b);
            } else {
                text.appendChild(document.createTextNode(seg.text));
            }
        }
        row.appendChild(text);
        band.appendChild(row);
    }

    if (matched.length > POPUP_ALERT_LIMIT) {
        const more = document.createElement('div');
        more.className = 'popup-alert-more';
        const n = matched.length - POPUP_ALERT_LIMIT;
        more.textContent = `+${n} more in Service Status`;
        band.appendChild(more);
    }

    band.classList.remove('hidden');
    return matched.length;
}

/**
 * Renders a station popup from a mergeArrivalResults() result.
 *
 * `result` carries the outcome, not just the data, so the four cases that used
 * to render an identical "—" are now distinguishable: no service, request
 * failed, partial data, and delayed data. onRetry is invoked by the retry
 * button shown in the error state.
 */
export function showPopup(popup, station, routeMap, result, onLineSelect, onRetry, alerts, stationMeta) {
    popup.querySelector('.popup-name').textContent = station.name;

    const { status = 'error', arrivals = [], updatedAt = null, failedCount = 0 } = result ?? {};

    const seenRoutes = [...new Set(arrivals.map(a => a.routeId))];
    const alertCount = renderAlerts(popup, station, routeMap, alerts, seenRoutes);

    if (status === 'error') {
        renderTrunks(popup, [], null, () => {});
        renderTabs(popup, [], null, () => {});
        renderMessage(popup, 'Couldn’t load arrivals');
        setNote(popup, 'Check your connection.', { retry: onRetry });
        popup.classList.remove('hidden');
        return;
    }

    if (status === 'empty') {
        renderTrunks(popup, [], null, () => {});
        renderTabs(popup, [], null, () => {});
        renderMessage(popup, 'No trains scheduled');
        // A partial failure here means we genuinely cannot claim "no service".
        // Otherwise the alert above, when there is one, *is* the explanation —
        // repeating the generic line under it would read as a contradiction.
        setNote(popup, failedCount > 0
            ? 'Some platforms could not be reached, so this may be incomplete.'
            : alertCount > 0
                ? ''
                : 'MTA is not publishing predictions for this station right now.');
        popup.classList.remove('hidden');
        return;
    }

    const notes = [];
    if (failedCount > 0) notes.push('Some platforms unavailable');
    if (isArrivalsStale(updatedAt)) notes.push(`Updated ${formatAge(updatedAt)}`);
    setNote(popup, notes.join(' · '));

    // A complex spans several GTFS ids; a trunk's direction labels come from
    // whichever id serves that trunk, so both are needed downstream.
    const stationIds = station.stationIds ?? [station.id];
    const trunks = trunksInArrivals(arrivals, trunksFor(routeMap));

    if (selection.stationId !== station.id) {
        selection = { stationId: station.id, trunkKey: null, dir: null };
    }

    // Falls back to the first trunk when the remembered one has no trains any
    // more — a selection that has stopped meaning anything should not survive.
    let activeTrunk = trunks.find(t => t.key === selection.trunkKey) ?? trunks[0] ?? null;
    let activeDir = selection.dir;   // may not exist on this trunk; checked below

    // Redraws every part of the popup that depends on the selected trunk —
    // including the chip bar itself, whose highlight would otherwise stay on
    // the trunk that was selected when the popup opened while the rows below
    // it changed.
    function renderForTrunk() {
        renderTrunks(popup, trunks, activeTrunk, selectTrunk, routeMap);
        const routeIds = activeTrunk?.routeIds ?? null;
        const split = splitByDirection(arrivals, routeIds);

        // Only offer a tab for a direction that has trains. At a terminal one
        // platform is genuinely empty, and an empty tab invites a pointless tap.
        const dirs = ['N', 'S'].filter(d => split[d].length > 0);
        if (!dirs.includes(activeDir)) activeDir = dirs[0] ?? null;

        selection.trunkKey = activeTrunk?.key ?? null;
        selection.dir = activeDir;

        const tabs = dirs.map(d => ({
            dir: d,
            label: directionLabel(
                stationMeta,
                stopIdForTrunk(stationMeta, stationIds, routeLabelsFor(routeIds, routeMap)),
                d,
                split[d][0]?.destination,
            ),
        }));

        renderTabs(popup, tabs, activeDir, (d) => { activeDir = d; renderForTrunk(); });
        renderArrivals(popup, activeDir ? split[activeDir] : [], routeMap, station);

        // Keeps the 3D line highlight in step with what the popup is showing.
        onLineSelect?.(routeIds?.[0] ?? seenRoutes[0]);
    }

    function selectTrunk(t) {
        activeTrunk = t;
        // The platforms differ per trunk, so the previous direction may not
        // exist here; renderForTrunk picks the first one that has trains.
        activeDir = null;
        renderForTrunk();
    }

    renderForTrunk();
    popup.classList.remove('hidden');
}

// Trunk chips. Hidden when there is only one trunk running — a lone control
// that cannot change anything is noise.
function renderTrunks(popup, trunks, active, onSelect, routeMap) {
    const bar = popup.querySelector('.popup-trunks');
    bar.innerHTML = '';
    if (trunks.length < 2) {
        bar.classList.add('hidden');
        return;
    }
    for (const t of trunks) {
        const btn = document.createElement('button');
        btn.className = 'popup-trunk' + (t === active ? ' popup-trunk--active' : '');
        btn.setAttribute('aria-pressed', String(t === active));
        for (const id of dedupeBulletRoutes(bulletRoutes(t.routeIds), routeMap)) {
            btn.appendChild(routeBullet(id, routeMap));
        }
        btn.addEventListener('click', () => onSelect(t));
        bar.appendChild(btn);
    }
    bar.classList.remove('hidden');
}

// The two direction tabs. A single tab still renders, so a terminal reads
// "Manhattan" rather than showing an unlabelled list.
function renderTabs(popup, tabs, activeDir, onSelect) {
    const bar = popup.querySelector('.popup-tabs');
    bar.innerHTML = '';
    if (tabs.length === 0) {
        bar.classList.add('hidden');
        return;
    }
    for (const t of tabs) {
        const btn = document.createElement('button');
        btn.className = 'popup-tab' + (t.dir === activeDir ? ' popup-tab--active' : '');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(t.dir === activeDir));
        btn.textContent = t.label;
        btn.addEventListener('click', () => onSelect(t.dir));
        bar.appendChild(btn);
    }
    bar.classList.remove('hidden');
}

// One row per train: the line's bullet, where it terminates, and how long.
// Routes interleave, so consecutive rows are frequently different lines — that
// ordering is the point, since a rider takes whichever comes first.
function renderArrivals(popup, list, routeMap, station) {
    const box = popup.querySelector('.popup-arrivals');
    box.innerHTML = '';

    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'arrival-empty';
        empty.textContent = 'No trains scheduled';
        box.appendChild(empty);
        return;
    }

    const render = (limit) => {
        box.innerHTML = '';
        for (const a of list.slice(0, limit)) {
            const row = document.createElement('div');
            row.className = 'arrival-row';

            row.appendChild(routeBullet(a.routeId, routeMap));

            const dest = document.createElement('span');
            dest.className = 'arrival-dest';
            // Falls back to the line's name when the feed gave no terminus, so
            // the row still says something rather than rendering a gap.
            dest.textContent = destinationName(a, station) || routeMap?.[a.routeId]?.shortName || '';
            row.appendChild(dest);

            const time = document.createElement('span');
            time.className = 'arrival-time';
            time.textContent = a.minutes <= 0 ? 'Now' : `${a.minutes} min`;
            row.appendChild(time);

            box.appendChild(row);
        }

        if (list.length > limit) {
            const more = document.createElement('button');
            more.className = 'popup-more';
            more.textContent = `Show ${list.length - limit} more`;
            more.addEventListener('click', () => render(list.length));
            box.appendChild(more);
        }
    };

    render(VISIBLE_ROWS);
}

// Station names are not carried on the arrival itself — only the destination's
// GTFS id — so the lookup is injected by main.js alongside the station list.
let stationNameLookup = null;

/** Supplies the id → name map used to render destinations. */
export function setStationNames(byId) {
    stationNameLookup = byId;
}

function destinationName(arrival, station) {
    const id = arrival?.destination;
    if (!id) return '';
    // A train terminating where the rider is standing is worth naming plainly.
    if (id === station?.id || (station?.stationIds ?? []).includes(id)) return station.name;
    return stationNameLookup?.get(id) ?? '';
}

// Replaces the arrivals area with a single explanatory line — loading, no
// service, or a failed request. Each says which, rather than sharing a dash.
function renderMessage(popup, text) {
    const box = popup.querySelector('.popup-arrivals');
    box.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'arrival-empty';
    el.textContent = text;
    box.appendChild(el);
}

// Opens the popup immediately in a loading state — station name shown, arrival
// columns showing a placeholder — while arrivals are fetched (Phase 5 lazy
// per-station fetch). showPopup replaces this with real data when it resolves.
export function showPopupLoading(popup, station, routeMap, alerts) {
    popup.querySelector('.popup-name').textContent = station.name;
    // Trunks and tabs are not known until arrivals land — which routes are
    // running is what decides them — so the chrome stays hidden rather than
    // rendering placeholder controls that would shift when the data arrives.
    renderTrunks(popup, [], null, () => {});
    renderTabs(popup, [], null, () => {});
    renderMessage(popup, 'Loading…');
    // Alerts need no fetch, so they are shown with the station name rather than
    // popping in when arrivals land. Routes are not known yet, so only the
    // station-scoped alerts appear here — which are the ones that explain an
    // empty station anyway.
    renderAlerts(popup, station, routeMap, alerts, []);
    setNote(popup, '');
    popup.classList.remove('hidden');
}

// The quiet line under the arrivals: staleness, partial failures, and the retry
// affordance. Empty text hides it entirely so a healthy popup is unchanged.
function setNote(popup, text, { retry } = {}) {
    const note = popup.querySelector('.popup-note');
    note.innerHTML = '';

    if (!text && !retry) {
        note.classList.add('hidden');
        return;
    }

    if (text) {
        const span = document.createElement('span');
        span.textContent = text;
        note.appendChild(span);
    }

    if (retry) {
        const btn = document.createElement('button');
        btn.className = 'popup-retry';
        btn.textContent = 'Retry';
        btn.addEventListener('click', retry);
        note.appendChild(btn);
    }

    note.classList.remove('hidden');
}

export function hidePopup(popup) {
    popup.classList.add('hidden');
}
