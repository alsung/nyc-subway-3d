// src/ui/camera.js
// Camera navigation via Maplibre's built-in pan and zoom.
//
// This module used to own a pitch curve: flat at overview zoom, tilting to 56
// degrees as you approached, on the reasoning that tilt is the only way to show
// one line running beneath another. That reasoning was sound and the payoff was
// not — the depth a tilted camera could have shown turned out to be illegible at
// every zoom, so the tilt was showing nothing. See "Why this is a 2D map" in the
// README. The camera is flat now, and there is no view toggle to release.

/**
 * Flies the map to center on a station at a closer zoom.
 */
export function flyToStation(map, station, zoom = 16) {
    map.flyTo({
        center: [station.lng, station.lat],
        zoom,
        duration: 1200,
    });
}

// Padding on any side of the map that nothing covers.
const EDGE = 80;
// The gap between a panel and what is fitted beside it.
const MARGIN = 20;
// The least map left showing in each direction, however large the panels.
const MIN_VIEW = 120;

/**
 * The padding for fitting something into the part of the map a panel leaves
 * showing. The trip panel is a side panel on desktop and a bottom sheet on a
 * phone, and a fixed padding fitted only one of them: the desktop's 420 px on
 * the left is wider than a phone's map, so Maplibre refused the fit and the
 * camera never moved (#146).
 *
 * Works from rectangles only, so it can be tested without a browser.
 *
 * @param {{width: number, height: number}} view the map's size
 * @param {{left: number, top: number, right: number, bottom: number}|null} panel
 *   the panel's edges relative to the map, or null when none is open
 * @param {number} [topInset] where the controls along the top of the map end
 * @returns {{top: number, right: number, bottom: number, left: number}}
 */
export function fitPadding(view, panel, topInset = 0) {
    const pad = { top: Math.max(EDGE, topInset + MARGIN), right: EDGE, bottom: EDGE, left: EDGE };

    if (panel) {
        const isSheet = panel.right - panel.left >= view.width / 2 && panel.bottom >= view.height - 1;
        if (isSheet) {
            pad.bottom = view.height - panel.top + MARGIN;
            pad.left = MARGIN;
            pad.right = MARGIN;
        } else {
            pad.left = panel.right + MARGIN;
        }
    }

    squeeze(pad, 'left', 'right', view.width);
    squeeze(pad, 'top', 'bottom', view.height);
    return pad;
}

// Shrinks both sides of one direction by the same proportion until MIN_VIEW of
// map is left between them. Padding that leaves no room at all makes Maplibre
// refuse the fit outright, which is worse than a fit that runs under an edge.
function squeeze(pad, a, b, size) {
    const room = Math.max(0, size - MIN_VIEW);
    const used = pad[a] + pad[b];
    if (used <= room) return;
    const scale = room / used;
    pad[a] = Math.floor(pad[a] * scale);
    pad[b] = Math.floor(pad[b] * scale);
}
