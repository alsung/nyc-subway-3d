// src/not-found.js
// The 404 page's one script (#119).
//
// Vercel answers any address without a file with dist/404.html, and a 404
// status. Most of those really are nothing, but two kinds of station link
// have to keep working: /station/611, the id with the name trimmed off, and
// /station/611-old-name, a link shared before MTA renamed the station. The
// app reads only the id from a station path (core/slugs.js), so it used to
// open both when every path loaded the app. Now only the full address has a
// page, so this sends those links on to it. A /line link typed in capitals
// (/line/G) goes on to /line/g the same way.
//
// Crawlers still see the 404, and keep only the real page. The list of real
// pages is in the page itself, written by scripts/build-seo-pages.mjs, so
// this makes no request and knows only addresses the build wrote a page for.
//
// Imports nothing, on purpose: a module shared with main.js would be split
// into a file of its own that the map then has to fetch before it starts.
// tests/unit/not-found.test.js holds the station pattern to slugs.js's.

// The same pattern as parseStationPath in core/slugs.js.
const STATION_PATH = /^\/station\/(\d+)(?:-[a-z0-9-]*)?\/?$/i;

/**
 * The page a 404'd address was meant for, or null when it names nothing.
 *
 * Never returns the address it was given, so a page missing from a deploy
 * can't send the browser in a loop.
 *
 * @param {string} pathname
 * @param {{stations?: Record<string, string>, lines?: string[]}} pages
 *   complex id → station page path, and every line page path
 */
export function pageFor(pathname, { stations = {}, lines = [] } = {}) {
    const path = String(pathname ?? '');
    const station = STATION_PATH.exec(path);
    if (station) {
        // The id is all digits, so it can't name anything an object inherits.
        const target = stations[station[1]];
        return typeof target === 'string' && target !== path ? target : null;
    }
    const lower = path.toLowerCase().replace(/\/+$/, '');
    return lines.includes(lower) && lower !== path ? lower : null;
}

/**
 * Sends the browser on to the page the address was meant for, keeping its
 * query and fragment. Does nothing when the list is missing or unreadable, so
 * the 404 page stays.
 *
 * @param {Document} doc
 * @param {Location} loc
 */
export function forward(doc, loc) {
    let pages;
    try {
        pages = JSON.parse(doc.getElementById('page-paths')?.textContent ?? '');
    } catch {
        return;
    }
    const target = pageFor(loc.pathname, pages ?? {});
    if (target) loc.replace(`${target}${loc.search}${loc.hash}`);
}

if (typeof document !== 'undefined') forward(document, location);
