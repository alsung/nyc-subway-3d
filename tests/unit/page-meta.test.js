import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    SITE, HOME, stationPageMeta, linePageMeta, stationJsonLd, lineJsonLd, sitemapXml,
} from '../../src/core/page-meta.js';

const routeMap = {
    A: { shortName: 'A', color: '#0062CF' },
    C: { shortName: 'C', color: '#0062CF' },
    F: { shortName: 'F', color: '#EB6800' },
    R: { shortName: 'R', color: '#F6BC26' },
    4: { shortName: '4', color: '#009952' },
    GS: { shortName: 'S', name: '42 St Shuttle', color: '#808183' },
    SI: { shortName: 'SIR', name: 'Staten Island Railway', color: '#08179C' },
    Z: { shortName: 'Z', name: 'Nassau St Express', color: '#8E5C33' },
};

const jay = { complexId: '636', name: 'Jay St-MetroTech', lat: 40.692259, lng: -73.987342 };
// The panel's rows, in the order stationModel gives them: the R's row ahead of
// the F's would still title the station in trunk order.
const jayModel = {
    name: 'Jay St-MetroTech',
    borough: 'Brooklyn',
    rows: [{ routeIds: ['A'] }, { routeIds: ['C'] }, { routeIds: ['R'] }, { routeIds: ['F'] }],
};

describe('HOME', () => {
    it('matches the head index.html ships, so closing a panel restores it exactly', () => {
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        const tag = (pattern) => pattern.exec(html)?.[1];
        expect(tag(/<title>([^<]*)<\/title>/)).toBe(HOME.title);
        expect(tag(/<meta name="description" content="([^"]*)"/)).toBe(HOME.description);
        expect(tag(/<meta property="og:title" content="([^"]*)"/)).toBe(HOME.title);
        expect(tag(/<meta property="og:description" content="([^"]*)"/)).toBe(HOME.ogDescription);
        expect(tag(/<meta property="og:url" content="([^"]*)"/)).toBe(`${SITE}/`);
        expect(tag(/<link rel="canonical" href="([^"]*)"/)).toBe(`${SITE}/`);
    });
});

describe('stationPageMeta', () => {
    it('names the station and its lines in trunk order', () => {
        const head = stationPageMeta(jay, jayModel, routeMap);
        expect(head.title).toBe('Jay St-MetroTech (A C F R) Live Train Arrivals | Local Express');
        expect(head.description).toBe('Live arrivals at Jay St-MetroTech in Brooklyn for the A, C, F and R, with next stops and service alerts.');
        expect(head.path).toBe('/station/636-jay-st-metrotech');
        expect(head.name).toBe('Jay St-MetroTech');
    });

    it('lists one or two lines without commas, and a shuttle as S once', () => {
        const one = stationPageMeta(jay, { ...jayModel, rows: [{ routeIds: ['A'] }] }, routeMap);
        expect(one.description).toContain('for the A, with');
        const two = stationPageMeta(jay, { ...jayModel, rows: [{ routeIds: ['GS', '4'] }] }, routeMap);
        expect(two.title).toContain('(4 S)');
        expect(two.description).toContain('for the 4 and S, with');
    });

    it('leaves out what it does not know', () => {
        const bare = stationPageMeta(undefined, { name: 'Somewhere', borough: '', rows: [] }, routeMap);
        expect(bare.title).toBe('Somewhere Live Train Arrivals | Local Express');
        expect(bare.description).toBe('Live arrivals at Somewhere, with next stops and service alerts.');
        expect(bare.path).toBe('/');
    });
});

describe('linePageMeta', () => {
    const a = { hours: { text: '24 hours' }, description: 'Trains operate between Inwood-207 St, Manhattan and Far Rockaway-Mott Av, Queens at all times. Also, from about 6 AM until about midnight, more trains run.' };

    it('calls a line "the A train" and adds the first sentence of its description', () => {
        const head = linePageMeta('A', a, routeMap);
        expect(head.title).toBe('A Train: Stops, Hours and Live Status | Local Express');
        expect(head.name).toBe('A Train');
        expect(head.description).toBe('Stops, hours and live status for the A train, which runs 24 hours a day. '
            + 'Trains operate between Inwood-207 St, Manhattan and Far Rockaway-Mott Av, Queens at all times.');
        expect(head.path).toBe('/line/a');
    });

    it('uses the name for a shuttle and the Staten Island Railway', () => {
        expect(linePageMeta('GS', {}, routeMap).title).toBe('42 St Shuttle: Stops, Hours and Live Status | Local Express');
        expect(linePageMeta('GS', {}, routeMap).path).toBe('/line/s-42-st');
        expect(linePageMeta('SI', {}, routeMap).description).toBe('Stops, hours and live status for the Staten Island Railway.');
    });

    it('puts each kind of hours in words', () => {
        const runs = (text) => linePageMeta('Z', { hours: { text } }, routeMap).description;
        expect(runs('No late nights')).toContain('the Z train, which runs every day except late nights.');
        expect(runs('Weekday rush hours only')).toContain('which runs in weekday rush hours only.');
        expect(runs('Weekdays only')).toContain('which runs on weekdays only.');
        expect(runs('Weekends only')).toContain('which runs on weekends only.');
        expect(runs('Not every day')).toContain("which doesn't run every day.");
        expect(runs('Something new')).toBe('Stops, hours and live status for the Z train.');
    });
});

describe('structured data', () => {
    it('describes a station with its place and a breadcrumb home', () => {
        const head = stationPageMeta(jay, jayModel, routeMap);
        const [station, crumbs] = stationJsonLd(jay, head)['@graph'];
        expect(station).toEqual({
            '@type': 'TrainStation',
            name: 'Jay St-MetroTech',
            url: `${SITE}/station/636-jay-st-metrotech`,
            geo: { '@type': 'GeoCoordinates', latitude: 40.69226, longitude: -73.98734 },
        });
        expect(crumbs.itemListElement.map(i => [i.name, i.item])).toEqual([
            ['Local Express', `${SITE}/`],
            ['Jay St-MetroTech', `${SITE}/station/636-jay-st-metrotech`],
        ]);
    });

    it('leaves out the location when there is none, and gives a line its breadcrumb', () => {
        const head = stationPageMeta(undefined, jayModel, routeMap);
        expect(stationJsonLd({}, head)['@graph'][0].geo).toBeUndefined();
        const line = lineJsonLd(linePageMeta('A', {}, routeMap));
        expect(line['@type']).toBe('BreadcrumbList');
        expect(line.itemListElement[1]).toMatchObject({ name: 'A Train', item: `${SITE}/line/a` });
    });
});

describe('sitemapXml', () => {
    it('lists one address per path, and nothing else', () => {
        const xml = sitemapXml(['/', '/station/636-jay-st-metrotech', '/line/a']);
        expect(xml.match(/<url>/g)).toHaveLength(3);
        expect(xml).toContain(`<url><loc>${SITE}/station/636-jay-st-metrotech</loc></url>`);
        expect(xml).not.toMatch(/lastmod|changefreq|priority/);
        expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    });

    it('escapes an address', () => {
        expect(sitemapXml(['/a&b'])).toContain(`<loc>${SITE}/a&amp;b</loc>`);
    });
});
