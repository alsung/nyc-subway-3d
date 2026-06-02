// src/ui/popup.js
// Station info card that appears when the user clicks a station mesh.
// Renders the station name and, if the station carries a routes array,
// a row of color-coded route badges matching the filter chip palette.

// Creates the popup element once, hidden, and appends it to container.
// Returns the element for use in showPopup / hidePopup.
export function buildPopup(container) {
    const popup = document.createElement('div');
    popup.id = 'station-popup';
    popup.classList.add('hidden');

    const name = document.createElement('div');
    name.className = 'popup-name';

    const badges = document.createElement('div');
    badges.className = 'popup-badges';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'popup-close';
    closeBtn.textContent = '×';

    popup.appendChild(closeBtn);
    popup.appendChild(name);
    popup.appendChild(badges);
    container.appendChild(popup);

    return popup;
}

// Populates the popup with station data and makes it visible.
// Clears any previous content before rendering so stale routes don't linger.
// Route badges are only rendered when station.routes is a non-empty array.
export function showPopup(popup, station, routeMap) {
    const name = popup.querySelector('.popup-name');
    const badges = popup.querySelector('.popup-badges');

    name.textContent = station.name;
    badges.innerHTML = '';

    if (Array.isArray(station.routes)) {
        for (const routeId of station.routes) {
            const route = routeMap[routeId];
            if (!route) continue;

            const badge = document.createElement('span');
            badge.className = 'popup-badge';
            badge.textContent = route.shortName;
            badge.style.backgroundColor = route.color;
            badge.style.color = route.textColor ?? '#FFFFFF';
            badges.appendChild(badge);
        }
    }

    popup.classList.remove('hidden');
}

// Hides the popup without destroying it so the DOM node can be reused.
export function hidePopup(popup) {
    popup.classList.add('hidden');
}
