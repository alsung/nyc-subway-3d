// scripts/build-seo-pages.mjs
// Pre-built pages for every station and line, and the sitemap (#155).
//
// The app is one HTML page that draws everything with JavaScript, so a crawler
// that reads /station/636-jay-st-metrotech without running it finds an empty
// map. This writes a real page for each station and line: the app's own
// index.html with that page's title, description and canonical URL, and its
// panel already open and filled in. The panel comes from core/place-card.js,
// the same code the app draws it with, so a visitor and a crawler read the same
// text, and the app takes the panel over when it loads (popup.js, line-panel.js).
//
// Runs after `vite build` and before verify-build.mjs, from the data the build
// just copied into dist/, so the pages describe exactly what ships. Vercel
// serves a file in dist/ before applying the app's catch-all rewrite, so
// /station/<slug> answers with dist/station/<slug>/index.html.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseStops, parseRoutes, buildStationComplexes } from '../src/core/gtfs-parser.js';
import { buildStationMeta, complexIdIndex } from '../src/core/station-meta.js';
import { parseEntrances, indexByComplex } from '../src/core/entrances.js';
import {
    escapeHtml, stationModel, lineModel, stationPanelElementHtml, linePanelElementHtml,
} from '../src/core/place-card.js';
import {
    SITE, HOME, stationPageMeta, linePageMeta, stationJsonLd, lineJsonLd, sitemapXml,
} from '../src/core/page-meta.js';

const DIST = 'dist';

// Where index.html marks the panel's place, inside #ui.
const PANEL_MARKER = /<!-- place-panel:[\s\S]*?-->/g;

/**
 * One page: the app's index.html with this page's head and its panel open.
 *
 * Every tag it replaces must be in the template exactly once. A template that
 * has lost one fails the build, rather than shipping 471 pages that all claim
 * to be the home page.
 *
 * @param {string} template dist/index.html
 * @param {{title: string, description: string, path: string, jsonLd: object, panelHtml: string}} page
 */
export function renderPage(template, page) {
    const url = `${SITE}${page.path}`;
    const attr = escapeHtml;
    let html = template;
    const swap = (pattern, replacement, what) => {
        const found = html.match(pattern)?.length ?? 0;
        if (found !== 1) throw new Error(`index.html has ${found} ${what}, expected exactly one`);
        // A function, so a "$" in a station name is never read as a pattern.
        html = html.replace(pattern, () => replacement);
    };
    swap(/<title>[^<]*<\/title>/g, `<title>${escapeHtml(page.title)}</title>`, '<title> tags');
    swap(/<meta name="description" content="[^"]*" \/>/g,
        `<meta name="description" content="${attr(page.description)}" />`, 'description tags');
    swap(/<link rel="canonical" href="[^"]*" \/>/g, `<link rel="canonical" href="${attr(url)}" />`, 'canonical links');
    swap(/<meta property="og:title" content="[^"]*" \/>/g,
        `<meta property="og:title" content="${attr(page.title)}" />`, 'og:title tags');
    swap(/<meta property="og:description" content="[^"]*" \/>/g,
        `<meta property="og:description" content="${attr(page.description)}" />`, 'og:description tags');
    swap(/<meta property="og:url" content="[^"]*" \/>/g, `<meta property="og:url" content="${attr(url)}" />`, 'og:url tags');
    // JSON inside a script element ends at the first "</script", so "<" is
    // written as its escape. Search engines read the data; the browser doesn't
    // run it, so the site's script-src policy doesn't apply.
    const json = JSON.stringify(page.jsonLd).replace(/</g, '\\u003c');
    swap(/<\/head>/g, `<script type="application/ld+json">${json}</script>\n</head>`, '</head> tags');
    swap(PANEL_MARKER, page.panelHtml, 'place-panel markers');
    return html;
}

/** Every station and line page, from the data in a build's output folder. */
export function buildPages(read) {
    const { stations } = parseStops(read('gtfs/stops.txt'));
    const routeMap = parseRoutes(read('gtfs/routes.txt'));
    const meta = buildStationMeta(JSON.parse(read('stations.json')));
    const entrances = indexByComplex(parseEntrances(JSON.parse(read('entrances.json'))));
    const lineOrder = JSON.parse(read('line-order.json'));

    // The same grouping and lookups main.js builds, so a page's panel matches
    // the one the app draws for the same station.
    const complexOf = complexIdIndex(meta);
    const complexById = new Map(buildStationComplexes(stations, complexOf)
        .filter(c => c.complexId)
        .map(c => [String(c.complexId), c]));
    const stationById = new Map(stations.map(s => [s.id, s]));
    const lookups = {
        complexOf: (id) => complexById.get(String(complexOf.get(id))),
        nameOf: (id) => stationById.get(id)?.name,
    };

    const stationPages = [...complexById.values()].map(complex => {
        const model = stationModel(complex, {
            meta, lineOrder, ...lookups,
            entrances: entrances.get(String(complex.complexId))?.length ?? null,
        });
        const head = stationPageMeta(complex, model, routeMap);
        return { ...head, jsonLd: stationJsonLd(complex, head), panelHtml: stationPanelElementHtml(model, routeMap) };
    });
    const linePages = Object.keys(lineOrder).map(lineId => {
        const model = lineModel(lineId, { lineOrder, routeMap, ...lookups });
        const head = linePageMeta(lineId, model, routeMap);
        return { ...head, jsonLd: lineJsonLd(head), panelHtml: linePanelElementHtml(model, routeMap) };
    });
    return { stationPages, linePages };
}

/** Titles or paths that more than one page claims. */
export function duplicates(pages, key) {
    const seen = new Map();
    for (const page of pages) seen.set(page[key], (seen.get(page[key]) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([value]) => value);
}

function main() {
    const read = (name) => {
        const path = join(DIST, name);
        try {
            return readFileSync(path, 'utf8');
        } catch {
            throw new Error(`${path} is missing. Did vite build run, after the prebuild download?`);
        }
    };
    const template = read('index.html');
    const { stationPages, linePages } = buildPages(read);
    const pages = [...stationPages, ...linePages];

    // Two pages with one title compete for the same searches; two with one
    // path overwrite each other. Neither happens with today's data.
    for (const key of ['path', 'title']) {
        const dupes = duplicates(pages, key);
        if (dupes.length) throw new Error(`pages share a ${key}: ${dupes.join('; ')}`);
    }

    for (const page of pages) {
        const file = join(DIST, page.path, 'index.html');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, renderPage(template, page));
    }
    writeFileSync(join(DIST, 'sitemap.xml'), sitemapXml([HOME.path, ...pages.map(p => p.path)]));

    console.log(`✓ pre-built ${stationPages.length} station pages and ${linePages.length} line pages, `
        + `and a sitemap of ${pages.length + 1} URLs`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (err) {
        console.error(`\nPre-built pages failed: ${err.message}\n`);
        process.exit(1);
    }
}
