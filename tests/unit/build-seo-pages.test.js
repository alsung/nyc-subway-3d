import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    renderPage, renderHome, renderNotFound, notFoundAssets, buildPages, duplicates, NOT_FOUND_TITLE, NOT_FOUND_HEADING,
} from '../../scripts/build-seo-pages.mjs';
import { SITE, HOME } from '../../src/core/page-meta.js';
import { linePath, parseStationPath } from '../../src/core/slugs.js';

// The source index.html: the build runs on the copy vite writes to dist/, which
// keeps these tags as they are here. CI has no dist/, so the tests use this.
const template = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

const page = {
    title: 'Jay St-MetroTech (A C F R) Live Train Arrivals | Local Express',
    description: "Live arrivals at Jay St-MetroTech in Brooklyn, with the R's next stops.",
    path: '/station/636-jay-st-metrotech',
    jsonLd: { '@type': 'TrainStation', name: 'Jay St </script> & Co' },
    panelHtml: '<div id="station-popup" class="place-panel">panel</div>',
};

describe('renderPage', () => {
    const html = renderPage(template, page);
    const url = `${SITE}${page.path}`;

    it('gives the page its own title, description and address', () => {
        expect(html).toContain(`<title>${page.title}</title>`);
        expect(html).toContain('<meta name="description" content="Live arrivals at Jay St-MetroTech in Brooklyn, with the R&#39;s next stops." />');
        expect(html).toContain(`<link rel="canonical" href="${url}" />`);
        expect(html).toContain(`<meta property="og:title" content="${page.title}" />`);
        expect(html).toContain(`<meta property="og:url" content="${url}" />`);
        expect(html).toContain('<meta property="og:description" content="Live arrivals');
        expect(html).not.toContain(HOME.title);
        expect(html).not.toContain(HOME.description);
    });

    it('puts the panel inside #ui, where the app would add it', () => {
        const ui = html.indexOf('<div id="ui">');
        const panel = html.indexOf(page.panelHtml);
        const map = html.indexOf('<div id="map">');
        expect(ui).toBeGreaterThan(-1);
        expect(panel).toBeGreaterThan(ui);
        expect(panel).toBeLessThan(map);
        expect(html).not.toContain('<!-- place-panel');
    });

    it('adds the structured data before </head>, unable to close its own script', () => {
        const json = /<script type="application\/ld\+json">(.*?)<\/script>\n<\/head>/.exec(html)?.[1];
        expect(json).toContain('\\u003c/script>');
        expect(JSON.parse(json)).toEqual(page.jsonLd);
    });

    it('leaves the home panel out, so the page has one heading, its own', () => {
        expect(html).not.toContain('<!-- search-home');
        expect(html).not.toContain('search-home');
    });

    it('keeps the rest of the page, including the app itself', () => {
        expect(html).toContain('<script type="module" src="/src/main.js"></script>');
        expect(html).toContain('<div id="privacy-modal"');
    });

    it('writes a "$" in a name as it is', () => {
        expect(renderPage(template, { ...page, title: 'Cost $& more' })).toContain('<title>Cost $&amp; more</title>');
    });

    it('fails when the template has lost a tag it replaces', () => {
        expect(() => renderPage(template.replace(/<!-- place-panel:[\s\S]*?-->/, ''), page))
            .toThrow('index.html has 0 place-panel markers, expected exactly one');
        expect(() => renderPage(template.replace(/<link rel="canonical"[^>]*>/, ''), page))
            .toThrow('0 canonical links');
    });
});

describe('renderHome', () => {
    const panelHtml = '<div id="search-home" class="place-panel search-home search-home--landing">home</div>';
    const html = renderHome(template, panelHtml);

    it('puts the home panel right after the search bar, so Tab goes from one to the other', () => {
        const search = html.indexOf('<div id="search-bar"></div>');
        const panel = html.indexOf(panelHtml);
        const controls = html.indexOf('<div id="view-controls">');
        expect(search).toBeGreaterThan(-1);
        expect(panel).toBeGreaterThan(search);
        expect(panel).toBeLessThan(controls);
        expect(html).not.toContain('<!-- search-home');
    });

    it("keeps the home page's own head", () => {
        expect(html).toContain(`<title>${HOME.title}</title>`);
        expect(html).toContain(`<link rel="canonical" href="${SITE}/" />`);
    });

    it('fails when the template has lost the marker', () => {
        expect(() => renderHome(template.replace(/<!-- search-home:[\s\S]*?-->/, ''), panelHtml))
            .toThrow('index.html has 0 search-home markers, expected exactly one');
    });
});

describe('renderNotFound', () => {
    const pagePaths = {
        stations: { 611: '/station/611-times-sq-42-st', 9: '/station/9-</script><b>' },
        lines: ['/line/g'],
    };
    const html = renderNotFound({
        cssHref: '/assets/index-abc.css',
        scriptSrc: '/assets/not-found-xyz.js',
        linesHtml: '<section class="place-section">lines</section>',
        pagePaths,
    });

    it('says the page is missing, and leads back to the map and to every line', () => {
        expect(html).toContain(`<title>${NOT_FOUND_TITLE}</title>`);
        expect(html).toContain(`<h1>${NOT_FOUND_HEADING}</h1>`);
        expect(html).toContain('<a class="auth-page-link" href="/">Open the live map</a>');
        expect(html.indexOf('<section class="place-section">lines</section>')).toBeGreaterThan(html.indexOf('href="/"'));
    });

    it("loads the map's stylesheet and its own script, but not the map", () => {
        expect(html).toContain('<link rel="stylesheet" crossorigin href="/assets/index-abc.css" />');
        expect(html).toContain('<script type="module" crossorigin src="/assets/not-found-xyz.js"></script>');
        expect(html.match(/<script type="module"/g)).toHaveLength(1);
        expect(html).not.toContain('gsi/client');
    });

    it('keeps itself out of search results, and claims no address', () => {
        expect(html).toContain('<meta name="robots" content="noindex" />');
        expect(html).not.toContain('rel="canonical"');
        expect(html).not.toContain('og:');
    });

    it('carries the list of pages for its script, unable to close its own script', () => {
        const json = /<script type="application\/json" id="page-paths">(.*?)<\/script>/.exec(html)?.[1];
        expect(json).toContain('\\u003c/script>');
        expect(JSON.parse(json)).toEqual(pagePaths);
    });
});

describe('notFoundAssets', () => {
    const built = '<link rel="stylesheet" crossorigin href="/assets/index-CLd2GYMb.css">';

    it("finds the map's stylesheet and the 404 page's script among the built files", () => {
        expect(notFoundAssets(`<head>${built}</head>`, ['index-D0.js', 'not-found-Cx96_8jm.js', 'index-CLd2GYMb.css']))
            .toEqual({ cssHref: '/assets/index-CLd2GYMb.css', scriptSrc: '/assets/not-found-Cx96_8jm.js' });
    });

    it('fails the build when either is missing or there is more than one', () => {
        expect(() => notFoundAssets('<head></head>', ['not-found-a.js'])).toThrow('0 built stylesheets');
        expect(() => notFoundAssets(built + built, ['not-found-a.js'])).toThrow('2 built stylesheets');
        expect(() => notFoundAssets(built, ['index-a.js'])).toThrow('0 not-found scripts');
        expect(() => notFoundAssets(built, ['not-found-a.js', 'not-found-b.js'])).toThrow('2 not-found scripts');
    });
});

// public/ holds the downloaded data the build copies into dist/. It is
// gitignored, so these run only where `npm run gtfs` has been.
const readPublic = (path) => readFileSync(fileURLToPath(new URL(`../../public/${path}`, import.meta.url)), 'utf8');
const hasData = (() => {
    try {
        ['gtfs/stops.txt', 'gtfs/routes.txt', 'stations.json', 'entrances.json', 'line-order.json'].forEach(readPublic);
        return true;
    } catch {
        return false;
    }
})();

describe.skipIf(!hasData)('buildPages, on the real data', () => {
    it("gives the home panel a link to every line that has a page", () => {
        const { homePanelHtml, linePages } = buildPages(readPublic);
        const lineIds = Object.keys(JSON.parse(readPublic('line-order.json')));
        expect(linePages).toHaveLength(lineIds.length);
        for (const id of lineIds) expect(homePanelHtml).toContain(`href="${linePath(id)}"`);
        expect(homePanelHtml).toContain('search-home--landing');
        expect(homePanelHtml).not.toMatch(/class="[^"]*\bhidden\b/);
    });

    it('gives the 404 page every station by its id, and every line', () => {
        const { stationPages, linePages, pagePaths, notFoundLinesHtml } = buildPages(readPublic);
        const stations = Object.entries(pagePaths.stations);
        expect(stations).toHaveLength(stationPages.length);
        expect(new Set(stations.map(([, path]) => path))).toEqual(new Set(stationPages.map(p => p.path)));
        for (const [id, path] of stations) expect(parseStationPath(path), path).toBe(id);
        expect(pagePaths.lines).toEqual(linePages.map(p => p.path));
        for (const path of pagePaths.lines) expect(notFoundLinesHtml).toContain(`href="${path}"`);
        expect(notFoundLinesHtml).not.toContain('search-home');
    });
});

describe('duplicates', () => {
    it('finds values more than one page claims', () => {
        const pages = [{ title: 'A' }, { title: 'B' }, { title: 'A' }];
        expect(duplicates(pages, 'title')).toEqual(['A']);
        expect(duplicates(pages.slice(0, 2), 'title')).toEqual([]);
    });
});
