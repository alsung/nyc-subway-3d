// src/ui/route-bullet.js
// The circular route badge — the "bullet" the MTA prints on signs and maps.
//
// Shared because the alerts panel and the lines panel both render it, and a
// rider reading the same line in two places must see the same badge. Two copies
// of this would drift, which is also why its label, colors and shape come from
// bulletSpec in core/place-card.js: the station panel's HTML bullets, which the
// pre-built pages carry too, read from the same place.

import { bulletSpec } from '../core/place-card.js';

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
    const spec = bulletSpec(routeId, routeMap);

    const el = document.createElement('span');
    el.className = 'alert-bullet';
    el.textContent = spec.label;
    el.style.backgroundColor = spec.color;
    el.style.color = spec.textColor;

    if (spec.express) el.classList.add('alert-bullet--express');
    else if (spec.wide) el.classList.add('alert-bullet--wide');
    return el;
}
