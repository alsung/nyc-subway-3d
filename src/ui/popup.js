import { contrastColor } from '../core/color.js';

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
    `;
    container.appendChild(popup);
    return popup;
}

export function showPopup(popup, station, routeMap, arrivals, onLineSelect) {
    popup.querySelector('.popup-name').textContent = station.name;

    const lineSelectEl = popup.querySelector('.popup-line-select');
    const [northCol, southCol] = popup.querySelectorAll('.popup-dir-col');
    lineSelectEl.innerHTML = '';

    if (!Array.isArray(arrivals) || arrivals.length === 0) {
        renderCol(northCol, [], DEFAULT_DIR.N, false);
        renderCol(southCol, [], DEFAULT_DIR.S, false);
        popup.classList.remove('hidden');
        return;
    }

    const seenRoutes = [...new Set(arrivals.map(a => a.routeId))];
    let activeRouteId = seenRoutes[0];

    function render(routeId) {
        const pool = arrivals.filter(a => a.routeId === routeId);
        const labels = DIRECTION_LABELS[routeId] ?? DEFAULT_DIR;
        renderCol(northCol, pool.filter(a => a.direction === 'N').slice(0, 4), `↑  ${labels.N}`, false);
        renderCol(southCol, pool.filter(a => a.direction === 'S').slice(0, 4), `↓  ${labels.S}`, false);
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

function renderCol(col, colArrivals, headerText, showBadge) {
    col.querySelector('.popup-dir-header').textContent = headerText;
    const list = col.querySelector('.popup-dir-list');
    list.innerHTML = '';

    if (colArrivals.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'arrival-empty';
        empty.textContent = '—';
        list.appendChild(empty);
        return;
    }

    for (const a of colArrivals) {
        const minText = a.minutes <= 0 ? 'Now' : `${a.minutes} min`;
        const row = document.createElement('div');
        row.className = 'arrival-row';
        if (showBadge) {
            // unused for now but left as extension point
        }
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
