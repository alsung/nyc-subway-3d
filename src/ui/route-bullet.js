// src/ui/route-bullet.js
// The circular route badge — the "bullet" the MTA prints on signs and maps.
//
// Shared because the alerts panel and the lines panel both render it, and a
// rider reading the same line in two places must see the same badge. Two copies
// of this would drift.

import { contrastColor } from '../core/color.js';

// Falls back to the MTA's own gray for a route the feed does not describe,
// rather than rendering an invisible or default-black bullet.
const UNKNOWN_COLOR = '#808183';

/**
 * A bullet for one route id. Label and color come from routeMap; unknown ids
 * render their raw id on gray so the line is still nameable.
 */
export function routeBullet(routeId, routeMap) {
    const route = routeMap?.[routeId];
    const color = route?.color ?? UNKNOWN_COLOR;
    const label = route?.shortName ?? routeId;

    const el = document.createElement('span');
    el.className = 'alert-bullet';
    el.textContent = label;
    el.style.backgroundColor = color;
    el.style.color = contrastColor(color);
    // SIR and similar need an oval; a circle would clip the third character.
    if (label.length > 2) el.classList.add('alert-bullet--wide');
    return el;
}
