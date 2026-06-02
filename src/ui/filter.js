// src/ui/filter.js
// Builds and manages the row of line filter chip buttons.
// Each chip toggles its route's visibility on the 3D map.

import { contrastColor } from '../core/color.js';

// Creates one chip button per route, appends them to container, and returns
// a Map<routeId, element> for programmatic state updates via setChipState.
export function buildFilterChips(routeMap, container, onToggle) {
    // for each route in Object.values(routeMap):
    //   create <button class="chip"> with route.shortName as text content
    //   set button background-color to route.color
    //   set button color to contrastColor(route.color)
    //   set button dataset.routeId = route.id
    //   set button dataset.active = 'true'
    //   on click: toggle dataset.active between 'true' and 'false'
    //             add/remove 'chip--inactive' class accordingly
    //             call onToggle(route.id, dataset.active === 'true')
    //   append button to container
    //   store in Map keyed by route.id
    // return the Map
    const chipMap = new Map();

    for (const route of Object.values(routeMap)) {
        const btn = document.createElement('button');
        btn.className = 'chip';
        btn.textContent = route.shortName;
        btn.style.backgroundColor = route.color;
        btn.style.color = contrastColor(route.color);
        btn.dataset.routeId = route.id;
        btn.dataset.active = 'true';

        btn.addEventListener('click', () => {
            const isActive = btn.dataset.active === 'true';
            const next = !isActive;
            btn.dataset.active = String(next);
            btn.classList.toggle('chip--inactive', !next);
            onToggle(route.id, next);
        });

        container.appendChild(btn);
        chipMap.set(route.id, btn);
    }

    return chipMap;
}

// Programmatically sets a chip's active state without triggering the click handler.
// Used when resetting filters or syncing chip state from outside the UI.
export function setChipState(chipMap, routeId, active) {
    // look up chip by routeId in chipMap
    // if not found, return
    // set chip.dataset.active to String(active)
    // toggle 'chip--inactive' class: add if !active, remove if active
    const chip = chipMap.get(routeId);
    if (!chip) return;
    chip.dataset.active = String(active);
    chip.classList.toggle('chip--inactive', !active);
}
