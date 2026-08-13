import { contrastColor } from '../core/color.js';
import { isArrivalsStale, formatAge } from '../core/arrivals.js';

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

/**
 * Renders a station popup from a mergeArrivalResults() result.
 *
 * `result` carries the outcome, not just the data, so the four cases that used
 * to render an identical "—" are now distinguishable: no service, request
 * failed, partial data, and delayed data. onRetry is invoked by the retry
 * button shown in the error state.
 */
export function showPopup(popup, station, routeMap, result, onLineSelect, onRetry) {
    popup.querySelector('.popup-name').textContent = station.name;

    const lineSelectEl = popup.querySelector('.popup-line-select');
    const [northCol, southCol] = popup.querySelectorAll('.popup-dir-col');
    lineSelectEl.innerHTML = '';

    const { status = 'error', arrivals = [], updatedAt = null, failedCount = 0 } = result ?? {};

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
        setNote(popup, failedCount > 0
            ? 'Some platforms could not be reached, so this may be incomplete.'
            : 'MTA is not publishing predictions for this station right now.');
        popup.classList.remove('hidden');
        return;
    }

    const notes = [];
    if (failedCount > 0) notes.push('Some platforms unavailable');
    if (isArrivalsStale(updatedAt)) notes.push(`Updated ${formatAge(updatedAt)}`);
    setNote(popup, notes.join(' · '));

    const seenRoutes = [...new Set(arrivals.map(a => a.routeId))];
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
export function showPopupLoading(popup, station) {
    popup.querySelector('.popup-name').textContent = station.name;
    popup.querySelector('.popup-line-select').innerHTML = '';
    const [northCol, southCol] = popup.querySelectorAll('.popup-dir-col');
    renderMessageCol(northCol, DEFAULT_DIR.N, 'Loading…');
    renderMessageCol(southCol, DEFAULT_DIR.S, 'Loading…');
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
