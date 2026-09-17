// src/ui/route-bullet.js
// The circular route badge — the "bullet" the MTA prints on signs and maps.
//
// Shared because the alerts panel and the lines panel both render it, and a
// rider reading the same line in two places must see the same badge. Two copies
// of this would drift.

import { contrastColor } from '../core/color.js';
import { expressParent } from '../core/trunks.js';

// Falls back to the MTA's own gray for a route the feed does not describe,
// rather than rendering an invisible or default-black bullet.
const UNKNOWN_COLOR = '#808183';

/**
 * A bullet for one route id. Label and color come from routeMap; unknown ids
 * render their raw id on gray so the line is still nameable.
 *
 * An express pattern is drawn as a diamond carrying its parent line's letter,
 * which is how MTA signs it. GTFS names these FX, 6X and 7X, but no sign in the
 * system reads "FX" — and this bullet appears in arrivals lists and inside alert
 * text, where a rider is reading to decide something. A row saying "7X
 * Flushing-Main St, 3 min" names a train nobody can look for on a platform.
 */
export function routeBullet(routeId, routeMap) {
    const route = routeMap?.[routeId];
    const color = route?.color ?? UNKNOWN_COLOR;

    const parent = expressParent(routeId);
    const label = parent
        ? (routeMap?.[parent]?.shortName ?? parent)
        : (route?.shortName ?? routeId);

    const el = document.createElement('span');
    el.className = 'alert-bullet';
    el.textContent = label;
    el.style.backgroundColor = color;
    el.style.color = contrastColor(color);

    if (parent) {
        el.classList.add('alert-bullet--express');
    } else if (label.length > 2) {
        // SIR and similar need an oval; a circle would clip the third character.
        // Never reachable for an express, whose label is always one character.
        el.classList.add('alert-bullet--wide');
    }
    return el;
}
