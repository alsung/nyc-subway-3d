// src/ui/line-chip.js
// The "G line ×" chip shown while a /line URL has one line highlighted.
//
// A line link opens no popup, and closing the popup used to be the only way to
// clear a highlight. The chip names what the map is showing and is the way out.

import { routeBullet } from './route-bullet.js';
import { lineName } from '../core/place-card.js';

// Moved to core so the station panel's line links, which the pre-built pages
// carry too, name lines the same way. Re-exported for the chip's callers.
export { lineName };

/**
 * @param {HTMLElement} container
 * @param {object} routeMap
 * @param {() => void} onClear called when the chip is dismissed
 * @returns {{show: (routeId: string) => void, hide: () => void}}
 */
export function buildLineChip(container, routeMap, onClear) {
    const chip = document.createElement('button');
    chip.id = 'line-chip';
    chip.type = 'button';
    chip.className = 'hidden';
    container.appendChild(chip);

    chip.addEventListener('click', () => onClear());

    return {
        show(routeId) {
            const name = lineName(routeId, routeMap);
            const label = document.createElement('span');
            label.className = 'line-chip-label';
            label.textContent = name;
            const close = document.createElement('span');
            close.className = 'line-chip-close';
            close.setAttribute('aria-hidden', 'true');
            close.textContent = '×';
            chip.replaceChildren(routeBullet(routeId, routeMap), label, close);
            chip.setAttribute('aria-label', `Showing the ${name}. Clear`);
            chip.classList.remove('hidden');
        },
        hide() {
            chip.classList.add('hidden');
        },
    };
}
