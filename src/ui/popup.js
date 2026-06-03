// src/ui/popup.js
// Station info card that appears when the user clicks a station mesh.
// Renders the station name, route badges, and live arrival times from the RT index.

import { contrastColor } from '../core/color.js';

// Creates the popup element once, hidden, and appends it to container.
// Returns the element for use in showPopup / hidePopup.
export function buildPopup(container) {
    const popup = document.createElement('div');
    popup.id = 'station-popup';
    popup.classList.add('hidden');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'popup-close';
    closeBtn.textContent = '×';

    const name = document.createElement('div');
    name.className = 'popup-name';

    const badges = document.createElement('div');
    badges.className = 'popup-badges';

    const arrivals = document.createElement('div');
    arrivals.className = 'popup-arrivals';

    popup.appendChild(closeBtn);
    popup.appendChild(name);
    popup.appendChild(badges);
    popup.appendChild(arrivals);
    container.appendChild(popup);

    return popup;
}

// Populates the popup with station data and live arrivals, then makes it visible.
// arrivals is the array from arrivalIndex[station.id] — pass null when RT data is not yet loaded.
// Clears all sections before rendering so stale content never lingers across clicks.
export function showPopup(popup, station, routeMap, arrivals) {
    popup.querySelector('.popup-name').textContent = station.name;

    const badgesEl = popup.querySelector('.popup-badges');
    badgesEl.innerHTML = '';
    if (Array.isArray(station.routes)) {
        for (const routeId of station.routes) {
            const route = routeMap[routeId];
            if (!route) continue;
            const badge = document.createElement('span');
            badge.className = 'popup-badge';
            badge.textContent = route.shortName;
            badge.style.backgroundColor = route.color;
            badge.style.color = route.textColor ?? '#FFFFFF';
            badgesEl.appendChild(badge);
        }
    }

    const arrivalsEl = popup.querySelector('.popup-arrivals');
    arrivalsEl.innerHTML = '';
    if (Array.isArray(arrivals) && arrivals.length > 0) {
        for (const a of arrivals.slice(0, 5)) {
            const route  = routeMap[a.routeId];
            const color  = route?.color ?? '#808183';
            const label  = route?.shortName ?? a.routeId;
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
    } else if (arrivals !== null && arrivals !== undefined) {
        const empty = document.createElement('div');
        empty.className = 'arrival-empty';
        empty.textContent = 'No upcoming arrivals';
        arrivalsEl.appendChild(empty);
    }

    popup.classList.remove('hidden');
}

// Hides the popup without destroying it so the DOM node can be reused.
export function hidePopup(popup) {
    popup.classList.add('hidden');
}
