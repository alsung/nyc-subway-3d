import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderPage, duplicates } from '../../scripts/build-seo-pages.mjs';
import { SITE, HOME } from '../../src/core/page-meta.js';

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

describe('duplicates', () => {
    it('finds values more than one page claims', () => {
        const pages = [{ title: 'A' }, { title: 'B' }, { title: 'A' }];
        expect(duplicates(pages, 'title')).toEqual(['A']);
        expect(duplicates(pages.slice(0, 2), 'title')).toEqual([]);
    });
});
