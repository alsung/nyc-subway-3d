// Post-build assertion: the GTFS static files must be in dist/.
//
// Every Vercel deployment up to 2026-08-11 shipped without them. The app did
// not crash — it silently fell back to an embedded 45-station dataset (out of
// 496) and rendered a map that looked plausible but was ~9% of the network.
// The SPA rewrite made the missing files return index.html with HTTP 200, so
// nothing in the pipeline registered a failure.
//
// This turns that silent degradation into a failed build.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SITE } from '../src/core/page-meta.js';
import { HOME_HEADING } from '../src/core/place-card.js';

const DIST = 'dist';
const REQUIRED = ['stops.txt', 'routes.txt', 'shapes.txt', 'trips.txt'];
const MIN_BYTES = 1024;

// Station metadata carries the borough and direction labels behind the popup's
// direction tabs. Missing, the tabs would silently fall back to generic
// compass labels — degraded rather than broken, which is exactly the shape of
// failure this file exists to catch.
const MIN_STATIONS = 490;

// Entrances degrade the same quiet way: the app catches the fetch failure and
// simply never draws an entrance, so a missing file looks like a station that
// happens to have none.
const MIN_ENTRANCES = 2000;

// Platform footprints. Unlike the GTFS files and the entrance data, this one is
// committed rather than fetched at build time: OSM platform geometry changes on
// the order of months, and putting a rate-limited Overpass query on the critical
// path of every deploy would trade a stale asset for a failed build.
const MIN_PLATFORMS = 800;

// Each line's stations in order and its hours, for the station and line panels
// and the pre-built pages (#153, #154). download-gtfs.sh already refuses to
// write fewer than this many lines, so a short file here means the prebuild
// step was skipped or the file was copied in from somewhere else.
const MIN_LINES = 24;

// The pre-built station and line pages (#155). 445 stations and 26 lines today;
// a short count means build-seo-pages.mjs didn't run or read thin data, and the
// missing pages would quietly fall back to the empty app shell.
const MIN_STATION_PAGES = 440;
const MIN_LINE_PAGES = 20;

const problems = [];

for (const name of REQUIRED) {
    const path = join(DIST, 'gtfs', name);
    let size;
    try {
        size = statSync(path).size;
    } catch {
        problems.push(`${path} is missing — did prebuild (scripts/download-gtfs.sh) run?`);
        continue;
    }
    if (size < MIN_BYTES) {
        problems.push(`${path} is only ${size} bytes — looks truncated`);
        continue;
    }
    // Guard against an HTML error page having been saved as a .txt.
    const head = readFileSync(path, 'utf8').slice(0, 200).trimStart();
    if (head.startsWith('<')) {
        problems.push(`${path} starts with '<' — that is markup, not CSV`);
        continue;
    }
    if (!head.includes(',')) {
        problems.push(`${path} has no comma in its first line — not valid GTFS CSV`);
    }
}

// stations.json — a JSON array, not CSV, so it gets its own checks.
try {
    const raw = readFileSync(join(DIST, 'stations.json'), 'utf8');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) {
        problems.push('dist/stations.json is not a JSON array');
    } else if (rows.length < MIN_STATIONS) {
        problems.push(`dist/stations.json has ${rows.length} stations, expected at least ${MIN_STATIONS}`);
    } else if (!rows[0]?.gtfs_stop_id || !rows[0]?.borough) {
        problems.push('dist/stations.json rows are missing gtfs_stop_id or borough');
    }
} catch (err) {
    problems.push(`dist/stations.json unreadable — did prebuild run? (${err.message})`);
}

// entrances.json — same treatment, same reason.
try {
    const rows = JSON.parse(readFileSync(join(DIST, 'entrances.json'), 'utf8'));
    if (!Array.isArray(rows)) {
        problems.push('dist/entrances.json is not a JSON array');
    } else if (rows.length < MIN_ENTRANCES) {
        problems.push(`dist/entrances.json has ${rows.length} entrances, expected at least ${MIN_ENTRANCES}`);
    } else if (!rows[0]?.c || !Number.isFinite(rows[0]?.y)) {
        problems.push('dist/entrances.json rows are missing a complex id or coordinates');
    }
} catch (err) {
    problems.push(`dist/entrances.json unreadable — did prebuild run? (${err.message})`);
}

// platforms.json — committed, so a failure here means it was deleted rather
// than that a fetch went wrong.
try {
    const rows = JSON.parse(readFileSync(join(DIST, 'platforms.json'), 'utf8'));
    if (!Array.isArray(rows)) {
        problems.push('dist/platforms.json is not a JSON array');
    } else if (rows.length < MIN_PLATFORMS) {
        problems.push(`dist/platforms.json has ${rows.length} platforms, expected at least ${MIN_PLATFORMS}`);
    } else if (!rows[0]?.c || !Array.isArray(rows[0]?.g)) {
        problems.push('dist/platforms.json rows are missing a complex id or geometry');
    }
} catch (err) {
    problems.push(`dist/platforms.json unreadable (${err.message})`);
}

// car-positions.json — generated by build-car-positions.mjs from the two files
// above. Degrades gracefully (no car advice shown), but its absence means the
// build script was not run.
try {
    const rows = JSON.parse(readFileSync(join(DIST, 'car-positions.json'), 'utf8'));
    if (!Array.isArray(rows)) {
        problems.push('dist/car-positions.json is not a JSON array');
    } else if (rows.length < 400) {
        problems.push(`dist/car-positions.json has ${rows.length} complexes, expected at least 400`);
    } else if (!rows[0]?.c || !Array.isArray(rows[0]?.p)) {
        problems.push('dist/car-positions.json rows are missing a complex id or platforms');
    }
} catch (err) {
    problems.push(`dist/car-positions.json unreadable (${err.message})`);
}

// line-order.json — generated by build-line-order.mjs during the download.
try {
    const lines = JSON.parse(readFileSync(join(DIST, 'line-order.json'), 'utf8'));
    const byLine = lines && typeof lines === 'object' && !Array.isArray(lines) ? Object.values(lines) : null;
    if (!byLine) {
        problems.push('dist/line-order.json is not an object of lines');
    } else if (byLine.length < MIN_LINES) {
        problems.push(`dist/line-order.json has ${byLine.length} lines, expected at least ${MIN_LINES}`);
    } else if (!byLine.every(l => Array.isArray(l?.sections) && l.sections.length > 0 && l.sections.every(Array.isArray))) {
        problems.push('dist/line-order.json has a line with no sections');
    } else if (!byLine.every(l => Array.isArray(l.hours?.days) && 'night' in l.hours)) {
        problems.push('dist/line-order.json has a line with no hours');
    }
} catch (err) {
    problems.push(`dist/line-order.json unreadable — did prebuild (scripts/download-gtfs.sh) run? (${err.message})`);
}

// Pre-built pages and the sitemap — written by build-seo-pages.mjs.
try {
    const home = readFileSync(join(DIST, 'index.html'), 'utf8');
    const bundle = /<script type="module" crossorigin src="(\/assets\/[^"]+)"/.exec(home)?.[1];
    if (!bundle) problems.push('dist/index.html has no module script for the app');
    if (canonicalOf(home) !== `${SITE}/`) problems.push(`dist/index.html canonical is ${canonicalOf(home)}, expected ${SITE}/`);

    const titles = new Map();
    const paths = [];
    for (const [kind, min, panelId, titleId] of [
        ['station', MIN_STATION_PAGES, 'station-popup', 'station-title'],
        ['line', MIN_LINE_PAGES, 'line-panel', 'line-title'],
    ]) {
        const slugs = listDirs(join(DIST, kind));
        if (slugs.length < min) problems.push(`dist/${kind}/ has ${slugs.length} pages, expected at least ${min}`);
        for (const slug of slugs) {
            const path = `/${kind}/${slug}`;
            const html = readFileSync(join(DIST, kind, slug, 'index.html'), 'utf8');
            paths.push(path);
            const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
            titles.set(title, [...(titles.get(title) ?? []), path]);
            // Each page has to name itself, carry its panel open, and load the
            // app; a page missing any of them is a dead end for whoever lands
            // on it.
            if (canonicalOf(html) !== `${SITE}${path}`) problems.push(`${path} canonical is ${canonicalOf(html)}`);
            if (!html.includes(`id="${panelId}" class="place-panel`) || html.includes(`id="${panelId}" class="place-panel hidden`)) {
                problems.push(`${path} has no open #${panelId}`);
            }
            if (!html.includes(`id="${titleId}"`)) problems.push(`${path} has no heading`);
            // The home panel's heading would be a second h1 on the page.
            if (html.includes('id="search-home"')) problems.push(`${path} carries the home panel`);
            if (bundle && !html.includes(`src="${bundle}"`)) problems.push(`${path} doesn't load the app's script`);
        }
    }
    // The home page's panel (#155): open, with its heading, and a link to
    // every line page, which is how a crawler gets from / to the lines and,
    // through their stop lists, to every station.
    const homePanel = /<div id="search-home" class="([^"]*)"/.exec(home)?.[1];
    if (homePanel === undefined) problems.push('dist/index.html has no home panel (#search-home)');
    else if (homePanel.split(' ').includes('hidden')) problems.push('dist/index.html ships its home panel closed');
    if (!home.includes(`<h1 class="place-title" id="search-home-title">${HOME_HEADING}</h1>`)) {
        problems.push(`dist/index.html has no "${HOME_HEADING}" heading`);
    }
    const unlinked = listDirs(join(DIST, 'line')).filter(slug => !home.includes(`href="/line/${slug}"`));
    if (unlinked.length) problems.push(`dist/index.html doesn't link ${unlinked.length} line pages, e.g. /line/${unlinked[0]}`);

    for (const [title, where] of titles) {
        if (!title || title === /<title>([^<]*)<\/title>/.exec(home)?.[1]) problems.push(`${where[0]} has the home page's title`);
        else if (where.length > 1) problems.push(`${where.join(', ')} share the title "${title}"`);
    }

    const sitemap = readFileSync(join(DIST, 'sitemap.xml'), 'utf8');
    const listed = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]));
    const expected = [`${SITE}/`, ...paths.map(p => `${SITE}${p}`)];
    const missing = expected.filter(url => !listed.has(url));
    if (listed.size !== expected.length || missing.length) {
        problems.push(`dist/sitemap.xml lists ${listed.size} URLs for ${expected.length} pages${missing.length ? `, missing ${missing[0]}` : ''}`);
    }
} catch (err) {
    problems.push(`pre-built pages unreadable — did build-seo-pages.mjs run? (${err.message})`);
}

if (problems.length) {
    console.error('\nBuild verification failed:\n');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('\nRefusing to ship a build that would silently fall back to embedded data.\n');
    process.exit(1);
}

console.log(`✓ build verified — ${REQUIRED.length} GTFS files in ${DIST}/gtfs, station, entrance, platform, car-position and line-order data present, pre-built pages, home panel and sitemap complete`);

function canonicalOf(html) {
    return /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1] ?? 'missing';
}

function listDirs(dir) {
    return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
}
