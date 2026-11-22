// src/core/place-card.js
// The station and line panels' HTML, and the home panel under the search bar,
// written the same way for the map and for the pre-built pages (#154, #155).
//
// A pre-built page has to show visitors the same text a crawler reads, or
// Google treats it as cloaking, so the panel a page ships must be the panel the
// app draws. Both come from here: popup.js and line-panel.js put this HTML into
// their panels, and scripts/build-seo-pages.mjs writes it into each page. It is HTML text
// rather than DOM so it runs in Node at build time, and every value passes
// through escapeHtml, since station names and labels come from outside data.
//
// The live parts (alerts, direction tabs, arrivals, line status) are empty
// slots here that the app fills, so a pre-built page shows them empty until it
// loads.

import { contrastColor } from './color.js';
import { expressParent, TRUNKS, trunksFor, bulletRoutes } from './trunks.js';
import { boroughName } from './station-meta.js';
import { linePath, stationPath } from './slugs.js';
import { neighbors, DAY_TYPES } from './line-order.js';

// MTA's gray, for a route the feed doesn't describe, rather than an invisible
// or default-black bullet.
const UNKNOWN_COLOR = '#808183';

// A line whose late-night trains still reach this share of its daytime
// stations reads as "some stops skipped" (the A, F and N), rather than naming
// the short stretch that's left (the 3, 5, M and R).
const MOST_STATIONS = 0.8;

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text made safe for HTML content and attribute values. */
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ENTITIES[c]);
}

/**
 * What a rider calls a route: "G line", or "42 St Shuttle" for the three
 * shuttles, which are all signed "S" and so need their long names.
 */
export function lineName(routeId, routeMap) {
    const route = routeMap?.[routeId];
    return route?.shortName === 'S' && route?.name
        ? route.name
        : `${route?.shortName ?? routeId} line`;
}

/**
 * How a route's bullet looks: its label, colors and shape.
 *
 * An express pattern carries its parent line's letter in a diamond, which is
 * how MTA signs it; no sign in the system reads "FX". A label longer than two
 * characters (SIR) needs an oval, since a circle would clip it. route-bullet.js
 * builds its DOM bullet from this too, so the two can't drift apart.
 *
 * @returns {{label: string, color: string, textColor: string, express: boolean, wide: boolean}}
 */
export function bulletSpec(routeId, routeMap) {
    const route = routeMap?.[routeId];
    const color = route?.color ?? UNKNOWN_COLOR;
    const parent = expressParent(routeId);
    const label = parent
        ? (routeMap?.[parent]?.shortName ?? parent)
        : (route?.shortName ?? routeId);
    return {
        label,
        color,
        textColor: contrastColor(color),
        express: Boolean(parent),
        wide: !parent && label.length > 2,
    };
}

/**
 * A route bullet as HTML, linking to the line's page when asked. `decorative`
 * hides it from screen readers, for a bullet beside text that already names
 * the line.
 */
export function bulletHtml(routeId, routeMap, { link = false, decorative = false } = {}) {
    const b = bulletSpec(routeId, routeMap);
    const classes = ['alert-bullet', b.express && 'alert-bullet--express', b.wide && 'alert-bullet--wide']
        .filter(Boolean).join(' ');
    const style = `background-color:${escapeHtml(b.color)};color:${escapeHtml(b.textColor)}`;
    const label = escapeHtml(b.label);
    if (!link) return `<span class="${classes}" style="${style}"${decorative ? ' aria-hidden="true"' : ''}>${label}</span>`;
    return `<a class="${classes}" style="${style}" href="${escapeHtml(linePath(routeId))}"`
        + ` aria-label="${escapeHtml(lineName(routeId, routeMap))}">${label}</a>`;
}

/**
 * When a line runs, in words, from its entry in line-order.json.
 *
 * `text` is the short label ("24 hours", "No late nights", "Weekdays only",
 * "Weekday rush hours only"); `detail` is a sentence with the times or the
 * late-night stretch. `tone` is "ok" for all night and "limited" otherwise.
 * Null when the entry has no hours.
 *
 * @param {{sections: string[][], hours?: object}} entry
 * @param {(stationId: string) => string} nameOf
 * @returns {{text: string, tone: string, detail: string}|null}
 */
export function hoursSummary(entry, nameOf = (id) => id) {
    const hours = entry?.hours;
    if (!hours) return null;
    const { days = [], night, spans = {} } = hours;

    if (night === true) return { text: '24 hours', tone: 'ok', detail: '' };

    if (Array.isArray(night)) {
        const daytime = new Set((entry.sections ?? []).flat()).size;
        if (night.length >= daytime * MOST_STATIONS) {
            return { text: '24 hours', tone: 'ok', detail: 'Some stops are skipped late at night.' };
        }
        const ends = nightEnds(entry.sections ?? [], new Set(night));
        return {
            text: '24 hours',
            tone: 'ok',
            detail: ends
                ? `Late at night, trains run only between ${nameOf(ends[0])} and ${nameOf(ends[1])}.`
                : 'Late at night, trains run on only part of the line.',
        };
    }

    const everyDay = DAY_TYPES.every(d => days.includes(d));
    const weekdays = spans.weekday ?? [];
    if (everyDay) {
        const same = DAY_TYPES.every(d => JSON.stringify(spans[d]) === JSON.stringify(weekdays));
        return { text: 'No late nights', tone: 'limited', detail: `About ${spanText(weekdays)}${same ? '' : ' on weekdays'}.` };
    }
    if (days.length === 1 && days[0] === 'weekday') {
        return weekdays.length > 1
            ? { text: 'Weekday rush hours only', tone: 'limited', detail: `About ${spanText(weekdays)}.` }
            : { text: 'Weekdays only', tone: 'limited', detail: `About ${spanText(weekdays)}.` };
    }
    if (days.length && !days.includes('weekday')) return { text: 'Weekends only', tone: 'limited', detail: '' };
    return { text: 'Not every day', tone: 'limited', detail: '' };
}

/**
 * The tag beside a line at one station, or null when the line runs there all
 * night. Only the exceptions are tagged, so a station served around the clock
 * reads calmly.
 *
 * @returns {{text: string, tone: string}|null}
 */
export function hoursTag(entry, stationId) {
    const hours = entry?.hours;
    if (!hours || hours.night === true) return null;
    if (Array.isArray(hours.night)) {
        return hours.night.includes(stationId) ? null : { text: 'No late nights', tone: 'limited' };
    }
    const { text } = hoursSummary(entry);
    return { text: text === 'Weekday rush hours only' ? 'Rush hours only' : text, tone: 'limited' };
}

/**
 * What the station panel shows about a station complex, from the same data on
 * the map and at build time.
 *
 * One row per line through the complex, each with the stations either side
 * and MTA's direction names for them. Lines that stop at the same neighbors
 * with the same hours share a row, so Jay St lists the A and C together only
 * when both run the same hours.
 *
 * @param {{complexId?: string, name: string, stationIds: string[]}} complex
 * @param {{meta: Map, lineOrder: object, entrances?: number, complexOf: (id: string) => object|undefined, nameOf?: (id: string) => string}} data
 */
export function stationModel(complex, { meta, lineOrder, entrances = null, complexOf, nameOf }) {
    const ids = complex?.stationIds ?? [];
    const borough = ids.map(id => boroughName(meta, id)).find(Boolean) ?? '';
    // A neighbor is named as its own platform is signed (the R's "Court St"),
    // not by its complex ("Borough Hall"), and links to the complex's page.
    const nameFor = (id) => nameOf?.(id) ?? complexOf?.(id)?.name ?? id;
    const linkFor = (id) => ({ name: nameFor(id), path: stationPath(complexOf?.(id)) });

    const rows = [];
    for (const routeId of inTrunkOrder(Object.keys(lineOrder ?? {}))) {
        const entry = lineOrder[routeId];
        for (const id of ids) {
            const { prev, next } = neighbors(entry.sections, id);
            if (!prev.length && !next.length) continue;
            const row = meta?.get(id);
            rows.push({
                routeIds: [routeId],
                north: { label: row?.north || 'Northbound', stops: prev.map(linkFor) },
                south: { label: row?.south || 'Southbound', stops: next.map(linkFor) },
                tag: hoursTag(entry, id),
            });
            break;
        }
    }

    return {
        name: complex?.name ?? '',
        borough,
        entrances,
        rows: mergeRows(rows),
    };
}

/**
 * The whole station panel, as a pre-built page ships it open and popup.js
 * builds it hidden. One function for both, so the panel the app takes over on
 * a pre-built page (#155) is the one it would have made.
 */
export function stationPanelElementHtml(model, routeMap, { hidden = false } = {}) {
    return `<div id="station-popup" class="place-panel${hidden ? ' hidden' : ''}" role="region" aria-labelledby="station-title">`
        + `${stationPanelHtml(model, routeMap)}</div>`;
}

/** The station panel's inside, empty when model is null (popup.js's shell). */
export function stationPanelHtml(model, routeMap) {
    return `<div class="place-head">`
        + `<button type="button" class="place-back hidden">‹ Trip</button>`
        + `<div class="place-heading">${model ? stationHeadingHtml(model) : ''}</div>`
        + `<button type="button" class="popup-close" aria-label="Close">✕</button>`
        + `</div>`
        + `<div class="place-body">`
        + `<div class="popup-trunks hidden"></div>`
        + `<div class="popup-alerts hidden"></div>`
        + `<div class="popup-tabs hidden" role="tablist"></div>`
        + `<div class="popup-arrivals"></div>`
        + `<div class="popup-note hidden"></div>`
        + `<div class="place-facts">${model ? stationFactsHtml(model, routeMap) : ''}</div>`
        + `</div>`;
}

/** The station's name as the page heading, with its borough and entrances. */
export function stationHeadingHtml(model) {
    const facts = [model.borough];
    if (model.entrances) facts.push(`${model.entrances} ${model.entrances === 1 ? 'entrance' : 'entrances'}`);
    const sub = facts.filter(Boolean).join(' · ');
    return `<h1 class="place-title" id="station-title">${escapeHtml(model.name)}</h1>`
        + (sub ? `<p class="place-sub">${escapeHtml(sub)}</p>` : '');
}

/**
 * The "Next stops" section, or nothing when there is no stop order.
 *
 * Each side ends in an empty slot for the next train's minutes (#161), keyed
 * by the row's lines and a platform direction, which popup.js fills from the
 * live arrivals. The stop order reads from the north end, so the north side is
 * where an N train goes next and the south side an S train. Pre-built pages
 * ship the slots empty.
 */
export function stationFactsHtml(model, routeMap) {
    if (!model.rows?.length) return '';
    const stops = (list) => list
        .map(s => (s.path ? `<a href="${escapeHtml(s.path)}">${escapeHtml(s.name)}</a>` : escapeHtml(s.name)))
        .join(' or ');
    const side = (dir, lines, platform) => (dir.stops.length
        ? `<span class="next-stop-dir"><span class="next-stop-label">${escapeHtml(dir.label)}</span> ${stops(dir.stops)}`
            + ` <span class="next-stop-time" data-lines="${escapeHtml(lines)}" data-dir="${platform}"></span></span>`
        : '');
    const items = model.rows.map(row => `<li class="next-stop">`
        + `<span class="next-stop-lines">${row.routeIds.map(id => bulletHtml(id, routeMap, { link: true })).join('')}</span>`
        + `<span class="next-stop-text">${side(row.north, row.routeIds.join(' '), 'N')}${side(row.south, row.routeIds.join(' '), 'S')}`
        + (row.tag ? `<span class="hours-tag hours-tag--${escapeHtml(row.tag.tone)}">${escapeHtml(row.tag.text)}</span>` : '')
        + `</span></li>`).join('');
    return `<section class="place-section" aria-labelledby="station-next-title">`
        + `<h2 class="place-section-title" id="station-next-title">Next stops</h2>`
        + `<ul class="next-stops">${items}</ul></section>`;
}

/**
 * What the line panel shows about one line, from the same data on the map and
 * at build time.
 *
 * Each section lists only stations not already listed, so a junction appears
 * once, in the first section that reaches it: the A lists Rockaway Blvd on its
 * trunk, and its Lefferts branch starts at the stop after. A line with more
 * than one section names each one by its ends.
 *
 * @param {string} lineId a line's route id, never an express pattern's
 * @param {{lineOrder: object, routeMap: object, complexOf?: (id: string) => object|undefined, nameOf?: (id: string) => string}} data
 */
export function lineModel(lineId, { lineOrder, routeMap, complexOf, nameOf }) {
    const route = routeMap?.[lineId] ?? {};
    const entry = lineOrder?.[lineId];
    const sections = entry?.sections ?? [];
    const night = entry?.hours?.night;
    const nameFor = (id) => nameOf?.(id) ?? complexOf?.(id)?.name ?? id;
    // Stops are marked "Not late nights" only when most of the line runs all
    // night, so the marks pick out the few it skips (the A's Rockaway Park
    // branch). When only a short stretch runs (the 5), the hours line names
    // that stretch, and marking 39 of 45 stops would bury it.
    const markNight = Array.isArray(night) && night.length >= new Set(sections.flat()).size * MOST_STATIONS;

    const linesAt = new Map();
    for (const [id, other] of Object.entries(lineOrder ?? {})) {
        for (const station of new Set((other.sections ?? []).flat())) {
            if (!linesAt.has(station)) linesAt.set(station, new Set());
            linesAt.get(station).add(id);
        }
    }
    const stop = (id) => {
        const transfers = new Set();
        for (const sibling of complexOf?.(id)?.stationIds ?? [id]) {
            for (const other of linesAt.get(sibling) ?? []) if (other !== lineId) transfers.add(other);
        }
        return {
            name: nameFor(id),
            path: stationPath(complexOf?.(id)),
            transfers: inTrunkOrder([...transfers]),
            notLate: markNight && !night.includes(id),
        };
    };

    const listed = new Set();
    const named = sections.length > 1;
    return {
        id: lineId,
        name: lineName(lineId, routeMap),
        longName: route.shortName === 'S' ? '' : (route.name ?? ''),
        stationCount: new Set(sections.flat()).size,
        hours: hoursSummary(entry, nameFor),
        description: route.desc ?? '',
        sections: sections.map(section => {
            const fresh = section.filter(id => !listed.has(id));
            fresh.forEach(id => listed.add(id));
            return {
                title: named ? `${nameFor(section[0])} to ${nameFor(section.at(-1))}` : '',
                stops: fresh.map(stop),
            };
        }),
    };
}

/** The whole line panel, for a pre-built page and line-panel.js alike. */
export function linePanelElementHtml(model, routeMap, { hidden = false } = {}) {
    return `<div id="line-panel" class="place-panel place-panel--line${hidden ? ' hidden' : ''}" role="region" aria-labelledby="line-title">`
        + `${linePanelHtml(model, routeMap)}</div>`;
}

/** The line panel's inside, empty when model is null (line-panel.js's shell). */
export function linePanelHtml(model, routeMap) {
    return `<div class="place-head">`
        + `<button type="button" class="place-back hidden">‹ Trip</button>`
        + `<div class="place-heading">${model ? lineHeadingHtml(model, routeMap) : ''}</div>`
        + `<button type="button" class="popup-close" aria-label="Close">✕</button>`
        + `</div>`
        + `<div class="place-body">${model ? lineFactsHtml(model, routeMap) : ''}</div>`;
}

/** The line's name as the page heading, with its long name and station count. */
export function lineHeadingHtml(model, routeMap) {
    const facts = [model.longName];
    if (model.stationCount) facts.push(`${model.stationCount} ${model.stationCount === 1 ? 'station' : 'stations'}`);
    const sub = facts.filter(Boolean).join(' · ');
    return `<div class="place-title-row">${bulletHtml(model.id, routeMap, { decorative: true })}`
        + `<h1 class="place-title" id="line-title">${escapeHtml(model.name)}</h1></div>`
        + (sub ? `<p class="place-sub">${escapeHtml(sub)}</p>` : '');
}

/**
 * Hours, MTA's description, an empty slot for live status, and the stops.
 * The description is complete here; line-panel.js shortens it to three lines
 * with a "More" button, so a page read without JavaScript shows all of it.
 */
export function lineFactsHtml(model, routeMap) {
    const color = escapeHtml(bulletSpec(model.id, routeMap).color);
    const hours = model.hours
        ? `<div class="line-hours"><span class="hours-tag hours-tag--${escapeHtml(model.hours.tone)}">${escapeHtml(model.hours.text)}</span>`
            + (model.hours.detail ? `<span class="line-hours-detail">${escapeHtml(model.hours.detail)}</span>` : '')
            + `</div>`
        : '';
    const description = model.description
        ? `<p class="line-desc">${escapeHtml(model.description)}</p>`
            + `<button type="button" class="line-more hidden" aria-expanded="false">More</button>`
        : '';
    const stop = (s) => {
        const name = s.path ? `<a href="${escapeHtml(s.path)}">${escapeHtml(s.name)}</a>` : `<span>${escapeHtml(s.name)}</span>`;
        const note = s.notLate ? `<span class="line-stop-note">Not late nights</span>` : '';
        const transfers = s.transfers.length
            ? `<span class="line-stop-transfers" role="img" aria-label="${escapeHtml(`Transfer to ${s.transfers.map(id => bulletSpec(id, routeMap).label).join(', ')}`)}">`
                + `${s.transfers.map(id => bulletHtml(id, routeMap, { decorative: true })).join('')}</span>`
            : '';
        return `<li class="line-stop">${name}${note}${transfers}</li>`;
    };
    const sections = model.sections.map(section => (section.title ? `<h3 class="line-branch">${escapeHtml(section.title)}</h3>` : '')
        + `<ol class="line-stops" style="--line:${color}">${section.stops.map(stop).join('')}</ol>`).join('');
    const stops = model.sections.length
        ? `<section class="place-section" aria-labelledby="line-stops-title">`
            + `<h2 class="place-section-title" id="line-stops-title">Stops from the north end</h2>${sections}</section>`
        : '';
    return `${hours}${description}<div class="line-status" aria-live="polite"></div>${stops}`;
}

// The home panel's words (#155). The page title in page-meta.js says the same
// thing with the site's name in front.
export const HOME_HEADING = 'Live NYC Subway Map';
export const HOME_INTRO = 'Every subway train in New York, moving on the map as the MTA reports it. '
    + 'Tap a station for live arrivals, or pick a line for its stops, hours and service status.';

// The three shuttles are all signed "S", so their bullets can't tell them
// apart, and the SIR is a railway rather than a subway line. They get their
// names written out, in this order.
const NAMED_LINES = ['GS', 'FS', 'H', 'SI'];
const SHORT_NAMES = { GS: '42 St', FS: 'Franklin Av', H: 'Rockaway Park', SI: 'Staten Island' };

/**
 * The home panel's inside: the site's heading, what it does, and a link to
 * every line page, grouped the way the Lines filter groups them.
 *
 * Only lines with a page are linked (lineIds, the keys of line-order.json), so
 * a link here never lands on the app's catch-all. The named rows' visible text
 * is short; their accessible name is the route's full name ("42 St Shuttle"),
 * which contains it.
 *
 * @param {object} routeMap
 * @param {string[]} lineIds
 */
export function searchHomeHtml(routeMap, lineIds) {
    const hasPage = new Set(lineIds ?? []);
    const groups = trunksFor(routeMap)
        .map(trunk => bulletRoutes(trunk.routeIds).filter(id => hasPage.has(id) && !NAMED_LINES.includes(id)))
        .filter(ids => ids.length);
    const named = NAMED_LINES.filter(id => hasPage.has(id) && routeMap?.[id]);

    const groupHtml = groups
        .map(ids => `<span class="home-group">${ids.map(id => bulletHtml(id, routeMap, { link: true })).join('')}</span>`)
        .join('');
    const namedHtml = named
        .map(id => `<a href="${escapeHtml(linePath(id))}" aria-label="${escapeHtml(routeMap[id].name || lineName(id, routeMap))}">`
            + `${bulletHtml(id, routeMap, { decorative: true })}<span>${escapeHtml(SHORT_NAMES[id])}</span></a>`)
        .join('');

    // No lines when line-order.json didn't load, and then no empty heading.
    const lines = groupHtml || namedHtml
        ? `<section class="place-section" aria-labelledby="home-lines-title">`
            + `<h2 class="place-section-title" id="home-lines-title">Lines</h2>`
            + (groupHtml ? `<nav class="home-lines" aria-label="Subway lines">${groupHtml}</nav>` : '')
            + (namedHtml ? `<div class="home-named">${namedHtml}</div>` : '')
            + `</section>`
        : '';

    return `<div class="place-head">`
        + `<div class="place-heading"><h1 class="place-title" id="search-home-title">${escapeHtml(HOME_HEADING)}</h1></div>`
        + `<button type="button" class="popup-close" aria-label="Close">✕</button>`
        + `</div>`
        + `<div class="place-body">`
        + `<p class="home-intro">${escapeHtml(HOME_INTRO)}</p>`
        + lines
        + `</div>`;
}

/**
 * The home panel with its wrapper. `landing` is the copy the build puts in the
 * home page: open on a wide screen and hidden by CSS on a phone, before any
 * script runs. `hidden` is the closed panel the app adds on other pages.
 */
export function searchHomeElementHtml(routeMap, lineIds, { hidden = false, landing = false } = {}) {
    const classes = ['place-panel', 'search-home', hidden && 'hidden', landing && 'search-home--landing']
        .filter(Boolean).join(' ');
    return `<div id="search-home" class="${classes}" role="region" aria-labelledby="search-home-title">`
        + `${searchHomeHtml(routeMap, lineIds)}</div>`;
}

/**
 * Lines in the order the rest of the app lists them (A C E, B D F M, ...), with
 * anything the trunk table doesn't know at the end.
 */
export function inTrunkOrder(routeIds) {
    const rank = new Map();
    for (const trunk of TRUNKS) for (const id of trunk.routeIds) if (!rank.has(id)) rank.set(id, rank.size);
    const at = (id) => (rank.has(id) ? rank.get(id) : Number.MAX_SAFE_INTEGER);
    return [...routeIds].sort((a, b) => at(a) - at(b) || a.localeCompare(b));
}

// Joins rows that differ only in their line, keeping the first row's place.
function mergeRows(rows) {
    const byKey = new Map();
    for (const row of rows) {
        const key = JSON.stringify([row.north, row.south, row.tag]);
        const seen = byKey.get(key);
        if (seen) seen.routeIds.push(...row.routeIds);
        else byKey.set(key, row);
    }
    return [...byKey.values()];
}

// The two ends of a late-night stretch, north end first: the stations with
// fewer than two late-night neighbors. Null when the stretch isn't one run.
function nightEnds(sections, night) {
    const ends = [...night].filter(id => {
        const { prev, next } = neighbors(sections, id);
        return [...prev, ...next].filter(n => night.has(n)).length < 2;
    });
    if (ends.length !== 2) return null;
    const runsSouth = (id) => neighbors(sections, id).next.some(n => night.has(n));
    return runsSouth(ends[0]) ? ends : [ends[1], ends[0]];
}

// "About 5:15 AM to 11:45 PM", or two ranges joined for a line with a break.
function spanText(spans) {
    return spans.map(([start, end]) => `${clock(start)} to ${clock(end)}`).join(' and ');
}

// Minutes after midnight on the service day → "6 AM", "11:45 PM", "midnight".
function clock(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    if (m === 0) return 'midnight';
    if (m === 720) return 'noon';
    const h = Math.floor(m / 60);
    const min = m % 60;
    return `${h % 12 || 12}${min ? `:${String(min).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}
