import { contrastColor } from '../core/color.js';
import { isArrivalsStale, formatAge } from '../core/arrivals.js';
import { alertsForStation } from '../core/station-alerts.js';
import { parseAlertText } from '../core/alert-text.js';
import { routeBullet } from './route-bullet.js';

// How many alerts to show before the popup turns into a wall of text. The
// panel is the place to read all of them; here we are answering "is something
// wrong with this station right now".
const POPUP_ALERT_LIMIT = 2;

const DIRECTION_LABELS = {
    '1':  { N: 'Uptown / Bronx',         S: 'Downtown / Brooklyn' },
    '2':  { N: 'Uptown / Bronx',         S: 'Downtown / Brooklyn' },
    '3':  { N: 'Uptown / Harlem',        S: 'Downtown / Brooklyn' },
    '4':  { N: 'Uptown / Bronx',         S: 'Downtown / Brooklyn' },
    '5':  { N: 'Uptown / Bronx',         S: 'Downtown / Brooklyn' },
    '6':  { N: 'Uptown / Bronx',         S: 'Downtown' },
    '7':  { N: 'Flushing',               S: 'Hudson Yards' },
    'A':  { N: 'Uptown / Inwood',        S: 'Ozone Pk / Rockaways' },
    'C':  { N: 'Uptown / Inwood',        S: 'Downtown / Brooklyn' },
    'E':  { N: 'Jamaica / Queens',       S: 'Downtown / Manhattan' },
    'B':  { N: 'Uptown / Bronx',         S: 'Downtown / Brooklyn' },
    'D':  { N: 'Uptown / Bronx',         S: 'Downtown / Brooklyn' },
    'F':  { N: 'Jamaica / Queens',       S: 'Downtown / Brooklyn' },
    'M':  { N: 'Forest Hills / Queens',  S: 'Downtown / Brooklyn' },
    'N':  { N: 'Astoria / Queens',       S: 'Downtown / Brooklyn' },
    'Q':  { N: 'Uptown / Manhattan',     S: 'Downtown / Brooklyn' },
    'R':  { N: 'Forest Hills / Queens',  S: 'Downtown / Brooklyn' },
    'W':  { N: 'Astoria / Queens',       S: 'Downtown / Manhattan' },
    'G':  { N: 'Long Island City',       S: 'Church Av / Brooklyn' },
    'J':  { N: 'Jamaica / Queens',       S: 'Downtown / Manhattan' },
    'Z':  { N: 'Jamaica / Queens',       S: 'Downtown / Manhattan' },
    'L':  { N: '8th Av / Manhattan',     S: 'Canarsie / Brooklyn' },
    'GS': { N: 'Times Square',           S: 'Grand Central' },
    'SI': { N: 'St. George',             S: 'Tottenville' },
};
const DEFAULT_DIR = { N: 'Uptown', S: 'Downtown' };

export function buildPopup(container) {
    const popup = document.createElement('div');
    popup.id = 'station-popup';
    popup.classList.add('hidden');
    popup.innerHTML = `
        <button class="popup-close">×</button>
        <div class="popup-name"></div>
        <div class="popup-line-select"></div>
        <div class="popup-alerts hidden"></div>
        <div class="popup-directions">
            <div class="popup-dir-col" data-dir="N">
                <div class="popup-dir-header"></div>
                <div class="popup-dir-list"></div>
            </div>
            <div class="popup-dir-divider"></div>
            <div class="popup-dir-col" data-dir="S">
                <div class="popup-dir-header"></div>
                <div class="popup-dir-list"></div>
            </div>
        </div>
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
export function showPopup(popup, station, routeMap, result, onLineSelect, onRetry, alerts) {
    popup.querySelector('.popup-name').textContent = station.name;

    const lineSelectEl = popup.querySelector('.popup-line-select');
    const [northCol, southCol] = popup.querySelectorAll('.popup-dir-col');
    lineSelectEl.innerHTML = '';

    const { status = 'error', arrivals = [], updatedAt = null, failedCount = 0 } = result ?? {};

    const seenRoutes = [...new Set(arrivals.map(a => a.routeId))];
    const alertCount = renderAlerts(popup, station, routeMap, alerts, seenRoutes);

    if (status === 'error') {
        renderMessageCol(northCol, DEFAULT_DIR.N, 'Couldn’t load arrivals');
        renderMessageCol(southCol, DEFAULT_DIR.S, 'Couldn’t load arrivals');
        setNote(popup, 'Check your connection.', { retry: onRetry });
        popup.classList.remove('hidden');
        return;
    }

    if (status === 'empty') {
        renderMessageCol(northCol, DEFAULT_DIR.N, 'No trains scheduled');
        renderMessageCol(southCol, DEFAULT_DIR.S, 'No trains scheduled');
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
    let activeRouteId = seenRoutes[0];

    function render(routeId) {
        const pool = arrivals.filter(a => a.routeId === routeId);
        const labels = DIRECTION_LABELS[routeId] ?? DEFAULT_DIR;
        renderCol(northCol, pool.filter(a => a.direction === 'N').slice(0, 4), `↑  ${labels.N}`);
        renderCol(southCol, pool.filter(a => a.direction === 'S').slice(0, 4), `↓  ${labels.S}`);
    }

    for (const routeId of seenRoutes) {
        const route = routeMap[routeId];
        const color = route?.color ?? '#808183';
        const label = route?.shortName ?? routeId;

        const btn = document.createElement('button');
        btn.className = 'line-btn' + (routeId === activeRouteId ? ' line-btn--active' : '');
        btn.textContent = label;
        btn.style.backgroundColor = color;
        btn.style.color = contrastColor(color);

        btn.addEventListener('click', () => {
            activeRouteId = routeId;
            lineSelectEl.querySelectorAll('.line-btn').forEach(b =>
                b.classList.toggle('line-btn--active', b === btn)
            );
            render(routeId);
            onLineSelect?.(routeId);
        });

        lineSelectEl.appendChild(btn);
    }

    render(activeRouteId);
    onLineSelect?.(activeRouteId);
    popup.classList.remove('hidden');
}

// Opens the popup immediately in a loading state — station name shown, arrival
// columns showing a placeholder — while arrivals are fetched (Phase 5 lazy
// per-station fetch). showPopup replaces this with real data when it resolves.
export function showPopupLoading(popup, station, routeMap, alerts) {
    popup.querySelector('.popup-name').textContent = station.name;
    popup.querySelector('.popup-line-select').innerHTML = '';
    const [northCol, southCol] = popup.querySelectorAll('.popup-dir-col');
    renderMessageCol(northCol, DEFAULT_DIR.N, 'Loading…');
    renderMessageCol(southCol, DEFAULT_DIR.S, 'Loading…');
    // Alerts need no fetch, so they are shown with the station name rather than
    // popping in when arrivals land. Routes are not known yet, so only the
    // station-scoped alerts appear here — which are the ones that explain an
    // empty station anyway.
    renderAlerts(popup, station, routeMap, alerts, []);
    setNote(popup, '');
    popup.classList.remove('hidden');
}

// A column with a single explanatory line instead of arrival times — loading,
// no service, or a failed request. Each says which, rather than sharing "—".
function renderMessageCol(col, headerText, message) {
    col.querySelector('.popup-dir-header').textContent = headerText;
    const list = col.querySelector('.popup-dir-list');
    list.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'arrival-empty';
    el.textContent = message;
    list.appendChild(el);
}

// The quiet line under the columns: staleness, partial failures, and the retry
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

function renderCol(col, colArrivals, headerText) {
    col.querySelector('.popup-dir-header').textContent = headerText;
    const list = col.querySelector('.popup-dir-list');
    list.innerHTML = '';

    // The route has service at this station but nothing in this direction —
    // a real fact about the schedule, distinct from a failed request.
    if (colArrivals.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'arrival-empty';
        empty.textContent = 'No trains scheduled';
        list.appendChild(empty);
        return;
    }

    for (const a of colArrivals) {
        const minText = a.minutes <= 0 ? 'Now' : `${a.minutes} min`;
        const row = document.createElement('div');
        row.className = 'arrival-row';
        const time = document.createElement('span');
        time.className = 'arrival-time';
        time.textContent = minText;
        row.appendChild(time);
        list.appendChild(row);
    }
}

export function hidePopup(popup) {
    popup.classList.add('hidden');
}
