// src/core/page-meta.js
// What a page says about itself in its <head>: title, description and address,
// for the home page, each station and each line (#155).
//
// The pre-built pages write these into their HTML, and the app sets the same
// values as the visitor moves around the map. Google runs a page's JavaScript
// before it indexes it, so if the app set a different title from the one the
// page shipped, the app's would likely win. One function per kind of page keeps
// the two in step. Like place-card.js, it is DOM-free so it runs in Node at
// build time.

import { bulletSpec, inTrunkOrder } from './place-card.js';
import { stationPath, linePath } from './slugs.js';

/** Where the site lives. Canonical URLs always name production, even on a preview. */
export const SITE = 'https://localexpress.nyc';

const BRAND = 'Local Express';

/**
 * The home page's head, exactly as index.html writes it (a test holds the two
 * together). The share card's description is shorter than the search one.
 */
export const HOME = {
    title: 'Local Express — Live NYC Subway Map',
    description: "Live NYC subway trains, arrivals, service alerts and trip planning on one map, built from the MTA's realtime GTFS feeds.",
    ogDescription: 'Live NYC subway trains, arrivals, trip planning and service alerts on one map.',
    path: '/',
};

/**
 * A station complex's title, description and path, from its stationModel().
 *
 * The lines come from the panel's Next stops rows, so the title names the lines
 * the page lists, in the order the panel lists them: "Jay St-MetroTech (A C F
 * R) Live Train Arrivals". The bullets also tell apart the stations that share
 * a name, such as the four 125 Sts.
 *
 * @param {{complexId?: string}|undefined} complex
 * @param {{name: string, borough: string, rows: {routeIds: string[]}[]}} model
 */
export function stationPageMeta(complex, model, routeMap) {
    const labels = stationLineLabels(model, routeMap);
    const name = model?.name ?? '';
    const borough = model?.borough ? ` in ${model.borough}` : '';
    const lines = labels.length ? ` for the ${listText(labels)}` : '';
    return {
        name,
        title: `${name}${labels.length ? ` (${labels.join(' ')})` : ''} Live Train Arrivals | ${BRAND}`,
        description: `Live arrivals at ${name}${borough}${lines}, with next stops and service alerts.`,
        path: stationPath(complex) ?? HOME.path,
    };
}

/**
 * A line's title, description and path, from its lineModel().
 *
 * Riders say "the A train", so that is the title; the shuttles, all signed "S",
 * and the Staten Island Railway go by their names instead. The description says
 * when the line runs and adds the first sentence of MTA's own description,
 * which names its ends.
 *
 * @param {string} lineId
 * @param {{hours: {text: string}|null, description: string}} model
 */
export function linePageMeta(lineId, model, routeMap) {
    const who = lineCalled(lineId, routeMap);
    const name = who.replace(/ train$/, ' Train');
    const runs = RUNS[model?.hours?.text] ? `, which ${RUNS[model.hours.text]}` : '';
    const first = firstSentence(model?.description);
    return {
        name,
        title: `${name}: Stops, Hours and Live Status | ${BRAND}`,
        description: `Stops, hours and live status for the ${who}${runs}.${first ? ` ${first}` : ''}`,
        path: linePath(lineId),
    };
}

/**
 * Structured data for a station page: the station with its location, and where
 * the page sits in the site. Search engines read it; visitors never see it.
 */
export function stationJsonLd(complex, head) {
    const station = {
        '@type': 'TrainStation',
        name: head.name,
        url: `${SITE}${head.path}`,
    };
    if (Number.isFinite(complex?.lat) && Number.isFinite(complex?.lng)) {
        station.geo = { '@type': 'GeoCoordinates', latitude: round(complex.lat), longitude: round(complex.lng) };
    }
    return { '@context': 'https://schema.org', '@graph': [station, breadcrumbs(head)] };
}

/** Structured data for a line page: where it sits in the site. */
export function lineJsonLd(head) {
    return { '@context': 'https://schema.org', ...breadcrumbs(head) };
}

/**
 * The sitemap for a list of paths. Only the address of each page, since search
 * engines ignore a change frequency and priority, and a last-modified date
 * would change on every deploy whether a page did or not.
 */
export function sitemapXml(paths) {
    const urls = paths.map(p => `  <url><loc>${xmlText(`${SITE}${p}`)}</loc></url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n`
        + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// When a line runs, as the end of a sentence, keyed by hoursSummary()'s label.
const RUNS = {
    '24 hours': 'runs 24 hours a day',
    'No late nights': 'runs every day except late nights',
    'Weekdays only': 'runs on weekdays only',
    'Weekday rush hours only': 'runs in weekday rush hours only',
    'Weekends only': 'runs on weekends only',
    'Not every day': "doesn't run every day",
};

// Home › page, as BreadcrumbList.
function breadcrumbs(head) {
    return {
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: BRAND, item: `${SITE}${HOME.path}` },
            { '@type': 'ListItem', position: 2, name: head.name, item: `${SITE}${head.path}` },
        ],
    };
}

// The bullet labels of the lines a station's panel lists, once each.
function stationLineLabels(model, routeMap) {
    const ids = inTrunkOrder(new Set((model?.rows ?? []).flatMap(r => r.routeIds)));
    return [...new Set(ids.map(id => bulletSpec(id, routeMap).label))];
}

// "the A train", or the name of a line whose bullet doesn't say which it is.
function lineCalled(lineId, routeMap) {
    const route = routeMap?.[lineId] ?? {};
    const label = route.shortName ?? lineId;
    if (route.name && (label === 'S' || label.length > 2)) return route.name;
    return `${label} train`;
}

// "A", "A and C", "A, C, F and R".
function listText(items) {
    if (items.length < 3) return items.join(' and ');
    return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// MTA's descriptions run several sentences; the first names the line's ends.
function firstSentence(text) {
    const trimmed = String(text ?? '').trim();
    const match = /^.*?[.!?](?=\s+[A-Z(]|$)/s.exec(trimmed);
    return match ? match[0] : trimmed;
}

// Five decimal places is about a meter, plenty for a station.
function round(n) {
    return Math.round(n * 1e5) / 1e5;
}

function xmlText(text) {
    return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}
