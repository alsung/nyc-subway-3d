import { contrastColor } from '../core/color.js';

const DIRECTION_LABELS = {
    '1':  { N: 'Uptown · Bronx',              S: 'Downtown · Brooklyn' },
    '2':  { N: 'Uptown · Bronx',              S: 'Downtown · Brooklyn' },
    '3':  { N: 'Uptown · Harlem',             S: 'Downtown · Brooklyn' },
    '4':  { N: 'Uptown · Bronx',              S: 'Downtown · Brooklyn' },
    '5':  { N: 'Uptown · Bronx',              S: 'Downtown · Brooklyn' },
    '6':  { N: 'Uptown · Bronx',              S: 'Downtown' },
    '7':  { N: 'Flushing · Queens',           S: 'Hudson Yards' },
    'A':  { N: 'Uptown · Inwood',             S: 'Downtown · Ozone Pk/Rockaways' },
    'C':  { N: 'Uptown · Inwood',             S: 'Downtown · Brooklyn' },
    'E':  { N: 'Jamaica · Queens',            S: 'Downtown · Manhattan' },
    'B':  { N: 'Uptown · Bronx',              S: 'Downtown · Brooklyn' },
    'D':  { N: 'Uptown · Bronx',              S: 'Downtown · Brooklyn' },
    'F':  { N: 'Jamaica · Queens',            S: 'Downtown · Brooklyn' },
    'M':  { N: 'Forest Hills · Queens',       S: 'Downtown · Brooklyn' },
    'N':  { N: 'Astoria · Queens',            S: 'Downtown · Brooklyn' },
    'Q':  { N: 'Uptown · Manhattan',          S: 'Downtown · Brooklyn' },
    'R':  { N: 'Forest Hills · Queens',       S: 'Downtown · Brooklyn' },
    'W':  { N: 'Astoria · Queens',            S: 'Downtown · Manhattan' },
    'G':  { N: 'Long Island City',            S: 'Church Av · Brooklyn' },
    'J':  { N: 'Jamaica · Queens',            S: 'Downtown · Manhattan' },
    'Z':  { N: 'Jamaica · Queens',            S: 'Downtown · Manhattan' },
    'L':  { N: '8th Av · Manhattan',          S: 'Canarsie · Brooklyn' },
    'GS': { N: 'Times Square',                S: 'Grand Central' },
    'SI': { N: 'St. George',                  S: 'Tottenville' },
};
const DEFAULT_DIR = { N: 'Uptown', S: 'Downtown' };

export function buildPopup(container) {
    const popup = document.createElement('div');
    popup.id = 'station-popup';
    popup.classList.add('hidden');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'popup-close';
    closeBtn.textContent = '×';

    const name = document.createElement('div');
    name.className = 'popup-name';

    const lineSelect = document.createElement('div');
    lineSelect.className = 'popup-line-select';

    const dirToggle = document.createElement('div');
    dirToggle.className = 'popup-dir-toggle';

    const arrivals = document.createElement('div');
    arrivals.className = 'popup-arrivals';

    popup.appendChild(closeBtn);
    popup.appendChild(name);
    popup.appendChild(lineSelect);
    popup.appendChild(dirToggle);
    popup.appendChild(arrivals);
    container.appendChild(popup);

    return popup;
}

export function showPopup(popup, station, routeMap, arrivals, onLineSelect) {
    popup.querySelector('.popup-name').textContent = station.name;

    const lineSelectEl = popup.querySelector('.popup-line-select');
    const dirToggleEl  = popup.querySelector('.popup-dir-toggle');
    const arrivalsEl   = popup.querySelector('.popup-arrivals');
    lineSelectEl.innerHTML = '';
    dirToggleEl.innerHTML  = '';
    arrivalsEl.innerHTML   = '';

    if (!Array.isArray(arrivals) || arrivals.length === 0) {
        popup.classList.remove('hidden');
        return;
    }

    const seenRoutes = [];
    const seen = new Set();
    for (const a of arrivals) {
        if (!seen.has(a.routeId)) {
            seen.add(a.routeId);
            seenRoutes.push(a.routeId);
        }
    }

    let activeRouteId  = seenRoutes[0];
    let activeDirection = null;

    function renderArrivals(routeId) {
        arrivalsEl.innerHTML = '';
        const filtered = arrivals
            .filter(a => a.routeId === routeId && (activeDirection === null || a.direction === activeDirection))
            .slice(0, 5);

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'arrival-empty';
            empty.textContent = activeDirection ? 'No arrivals in this direction' : 'No upcoming arrivals';
            arrivalsEl.appendChild(empty);
            return;
        }

        for (const a of filtered) {
            const route    = routeMap[a.routeId];
            const color    = route?.color ?? '#808183';
            const label    = route?.shortName ?? a.routeId;
            const dirArrow = a.direction === 'N' ? '↑' : a.direction === 'S' ? '↓' : '→';
            const minText  = a.minutes <= 0 ? 'Now' : `${a.minutes} min`;

            const row = document.createElement('div');
            row.className = 'arrival-row';

            const dot = document.createElement('span');
            dot.className = 'arrival-dot';
            dot.textContent = label;
            dot.style.backgroundColor = color;
            dot.style.color = contrastColor(color);

            const dir = document.createElement('span');
            dir.className = 'arrival-dir';
            dir.textContent = dirArrow;

            const time = document.createElement('span');
            time.className = 'arrival-time';
            time.textContent = minText;

            row.appendChild(dot);
            row.appendChild(dir);
            row.appendChild(time);
            arrivalsEl.appendChild(row);
        }
    }

    function renderDirToggle(routeId) {
        dirToggleEl.innerHTML = '';
        const labels = DIRECTION_LABELS[routeId] ?? DEFAULT_DIR;
        const hasN = arrivals.some(a => a.routeId === routeId && a.direction === 'N');
        const hasS = arrivals.some(a => a.routeId === routeId && a.direction === 'S');
        if (!hasN || !hasS) return;

        for (const dir of ['N', 'S']) {
            const btn = document.createElement('button');
            btn.className = 'dir-btn' + (activeDirection === dir ? ' dir-btn--active' : '');
            btn.textContent = dir === 'N' ? `↑  ${labels.N}` : `↓  ${labels.S}`;
            btn.addEventListener('click', () => {
                activeDirection = activeDirection === dir ? null : dir;
                renderDirToggle(routeId);
                renderArrivals(routeId);
            });
            dirToggleEl.appendChild(btn);
        }
    }

    for (const routeId of seenRoutes) {
        const route = routeMap[routeId];
        const color = route?.color ?? '#808183';
        const label = route?.shortName ?? routeId;

        const btn = document.createElement('button');
        btn.className = 'line-btn';
        btn.textContent = label;
        btn.style.backgroundColor = color;
        btn.style.color = contrastColor(color);
        if (routeId === activeRouteId) btn.classList.add('line-btn--active');

        btn.addEventListener('click', () => {
            activeRouteId  = routeId;
            activeDirection = null;
            lineSelectEl.querySelectorAll('.line-btn').forEach(b =>
                b.classList.toggle('line-btn--active', b === btn)
            );
            renderDirToggle(routeId);
            renderArrivals(routeId);
            onLineSelect?.(routeId);
        });

        lineSelectEl.appendChild(btn);
    }

    renderDirToggle(activeRouteId);
    renderArrivals(activeRouteId);
    onLineSelect?.(activeRouteId);

    popup.classList.remove('hidden');
}

export function hidePopup(popup) {
    popup.classList.add('hidden');
}
