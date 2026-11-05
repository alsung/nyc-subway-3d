// src/core/slugs.js
// URLs for stations and lines: /station/611-times-sq-42-st and /line/g.
//
// A station is addressed by MTA's complex id, with the name after it for
// people reading the link. Only the id is read back, so a link keeps working
// if MTA renames a station or someone trims the name off by hand. The id is
// the same one the popup groups platforms by, so a link opens the same set of
// platforms a click on the map would.
//
// Kept free of the DOM so the pre-rendered page build (#118) can produce the
// same paths the app reads.

import { expressParent } from './trunks.js';

/**
 * A name as a URL segment: "Times Sq-42 St" → "times-sq-42-st".
 *
 * Apostrophes are dropped rather than turned into a dash, so "Bway" style
 * contractions stay one word. Accented letters lose their accents.
 */
export function slugify(name) {
    return String(name ?? '')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** "611-times-sq-42-st", or null for a group with no complex id. */
export function stationSlug(complex) {
    if (!complex?.complexId) return null;
    const name = slugify(complex.name);
    return name ? `${complex.complexId}-${name}` : String(complex.complexId);
}

/** The path for a station complex, or null when it has no complex id. */
export function stationPath(complex) {
    const slug = stationSlug(complex);
    return slug ? `/station/${slug}` : null;
}

const STATION_PATH = /^\/station\/(\d+)(?:-[a-z0-9-]*)?\/?$/i;

/** The complex id in a /station path, or null for anything else. */
export function parseStationPath(pathname) {
    const match = STATION_PATH.exec(String(pathname ?? ''));
    return match ? match[1] : null;
}

// The routes whose short name does not identify them. All three shuttles are
// signed "S", and the Staten Island Railway is "SIR" to riders.
const LINE_SLUGS = {
    GS: 's-42-st',
    FS: 's-franklin-av',
    H: 's-rockaway-park',
    SI: 'sir',
};

/**
 * The path segment for a route: "g", "a", "s-42-st".
 *
 * An express pattern shares its line's slug, so /line/6 covers the 6X too. No
 * rider looks for "the 6X"; MTA signs it as a diamond 6.
 */
export function lineSlug(routeId) {
    const id = String(routeId ?? '');
    return LINE_SLUGS[id] ?? (expressParent(id) ?? id).toLowerCase();
}

/** The path for a route's line page. */
export function linePath(routeId) {
    return `/line/${lineSlug(routeId)}`;
}

const LINE_PATH = /^\/line\/([a-z0-9-]+)\/?$/i;

/**
 * The route a /line path names, among the routes the map loaded, or null.
 *
 * Returns the line itself rather than an express pattern, so /line/6 is the 6
 * even though the 6X shares its slug.
 */
export function parseLinePath(pathname, routeIds) {
    const match = LINE_PATH.exec(String(pathname ?? ''));
    if (!match) return null;
    const slug = match[1].toLowerCase();
    const ids = [...(routeIds ?? [])];
    return ids.find(id => lineSlug(id) === slug && !expressParent(id))
        ?? ids.find(id => lineSlug(id) === slug)
        ?? null;
}

/** A route and its express patterns: "6" → ["6", "6X"]. */
export function lineRouteIds(routeId, routeIds) {
    return [...(routeIds ?? [])].filter(id => id === routeId || expressParent(id) === routeId);
}
