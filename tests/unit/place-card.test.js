import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    escapeHtml, lineName, bulletSpec, bulletHtml, hoursSummary, hoursTag,
    stationModel, stationPanelHtml, stationHeadingHtml, stationFactsHtml,
    lineModel, linePanelHtml, lineFactsHtml,
} from '../../src/core/place-card.js';
import { buildStationMeta } from '../../src/core/station-meta.js';
import { lineSections } from '../../src/core/line-order.js';

// Real stop order for the 5, from the #153 fixture, for the late-night ends.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/line-order-feed.json', import.meta.url), 'utf8'));

const routeMap = {
    A: { shortName: 'A', color: '#0062CF' },
    C: { shortName: 'C', color: '#0062CF' },
    E: { shortName: 'E', color: '#0062CF' },
    F: { shortName: 'F', color: '#EB6800' },
    R: { shortName: 'R', color: '#F6BC26' },
    '6X': { shortName: '6X', color: '#009952' },
    '6': { shortName: '6', color: '#009952' },
    SI: { shortName: 'SIR', color: '#08179C' },
    GS: { shortName: 'S', name: '42 St Shuttle', color: '#808183' },
};

const ALL_NIGHT = { days: ['weekday', 'saturday', 'sunday'], night: true };
const C_HOURS = {
    days: ['weekday', 'saturday', 'sunday'], night: false,
    spans: { weekday: [[315, 1425]], saturday: [[330, 1425]], sunday: [[405, 1410]] },
};

// Jay St-MetroTech, with made-up neighbors where only the shape matters.
const meta = buildStationMeta([
    { gtfs_stop_id: 'A41', complex_id: '636', borough: 'Bk', north_direction_label: 'Manhattan', south_direction_label: 'Outbound' },
    { gtfs_stop_id: 'R29', complex_id: '636', borough: 'Bk', north_direction_label: 'Manhattan', south_direction_label: 'Southbound' },
]);
const names = { A40: 'High St', A42: 'Hoyt-Schermerhorn Sts', F18: 'York St', F20: 'Bergen St', R28: 'Court St', R30: 'DeKalb Av' };
const complexOf = (id) => (names[id] ? { complexId: `9${id.slice(1)}`, name: names[id] } : undefined);
const lineOrder = {
    A: { sections: [['A40', 'A41', 'A42']], hours: ALL_NIGHT },
    C: { sections: [['A40', 'A41', 'A42']], hours: C_HOURS },
    E: { sections: [['A40', 'A41', 'A42']], hours: ALL_NIGHT },
    F: { sections: [['F18', 'A41', 'F20']], hours: ALL_NIGHT },
    R: { sections: [['R27', 'R28', 'R29', 'R30', 'R31']], hours: { days: ALL_NIGHT.days, night: ['R28', 'R29', 'R30'] } },
};
const jay = { complexId: '636', name: 'Jay St-MetroTech', stationIds: ['A41', 'R29'] };
const model = () => stationModel(jay, { meta, lineOrder, entrances: 17, complexOf });

describe('escapeHtml', () => {
    it('escapes everything that could open a tag or close an attribute', () => {
        expect(escapeHtml(`<a href="x">Tom's & co</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom&#39;s &amp; co&lt;/a&gt;');
        expect(escapeHtml(null)).toBe('');
    });
});

// Moved here from line-chip.test.js with the chip's removal (#154).
describe('lineName', () => {
    const names = {
        G: { shortName: 'G', name: 'Brooklyn-Queens Crosstown' },
        SI: { shortName: 'SIR', name: 'Staten Island Railway' },
        GS: { shortName: 'S', name: '42 St Shuttle' },
        FS: { shortName: 'S', name: 'Franklin Avenue Shuttle' },
        H: { shortName: 'S', name: 'Rockaway Park Shuttle' },
    };

    it('names a line by its short name', () => {
        expect(lineName('G', names)).toBe('G line');
        expect(lineName('SI', names)).toBe('SIR line');
    });

    it('names each shuttle by its long name, since all three are signed "S"', () => {
        expect(['GS', 'FS', 'H'].map(id => lineName(id, names)))
            .toEqual(['42 St Shuttle', 'Franklin Avenue Shuttle', 'Rockaway Park Shuttle']);
    });

    it('falls back to the route id for a route the map does not know', () => {
        expect(lineName('Q9', names)).toBe('Q9 line');
    });
});

describe('bulletSpec and bulletHtml', () => {
    it('draws an express as a diamond with its parent line\'s label', () => {
        expect(bulletSpec('6X', routeMap)).toMatchObject({ label: '6', express: true, wide: false });
    });

    it('widens a three-character label and grays an unknown route', () => {
        expect(bulletSpec('SI', routeMap)).toMatchObject({ label: 'SIR', wide: true });
        expect(bulletSpec('ZZ', routeMap)).toMatchObject({ label: 'ZZ', color: '#808183' });
    });

    it('links to the line\'s page, named for screen readers', () => {
        const html = bulletHtml('A', routeMap, { link: true });
        expect(html).toMatch(/^<a class="alert-bullet" /);
        expect(html).toContain('href="/line/a"');
        expect(html).toContain('aria-label="A line"');
    });
});

describe('hoursSummary', () => {
    it('says 24 hours for a line that runs all night everywhere', () => {
        expect(hoursSummary({ sections: [['a', 'b']], hours: ALL_NIGHT })).toEqual({ text: '24 hours', tone: 'ok', detail: '' });
    });

    it('names the short stretch a line keeps late at night, north end first', () => {
        // The 5's real sections, with its late-night stretch: the Dyre Av branch
        // down to E 180 St.
        const { patterns, daytime } = fixture.lines['5'];
        const { sections } = lineSections(patterns, new Set(daytime));
        const dyreBranch = sections.find(s => s[0] === idNamed('Eastchester-Dyre Av'));
        const entry = { sections, hours: { days: ALL_NIGHT.days, night: dyreBranch } };

        expect(hoursSummary(entry, id => fixture.names[id])).toEqual({
            text: '24 hours',
            tone: 'ok',
            detail: 'Late at night, trains run only between Eastchester-Dyre Av and E 180 St.',
        });
    });

    it('says some stops are skipped when most of the line still runs at night', () => {
        const sections = [['a', 'b', 'c', 'd', 'e']];
        const summary = hoursSummary({ sections, hours: { days: ALL_NIGHT.days, night: ['a', 'b', 'c', 'd'] } });
        expect(summary.detail).toBe('Some stops are skipped late at night.');
    });

    it('gives the hours of a line with no late nights, and says when weekends differ', () => {
        expect(hoursSummary({ sections: [], hours: C_HOURS })).toEqual({
            text: 'No late nights', tone: 'limited', detail: 'About 5:15 AM to 11:45 PM on weekdays.',
        });
    });

    it('reads past midnight on the service day as the early morning', () => {
        const gs = { days: ALL_NIGHT.days, night: false, spans: { weekday: [[360, 1455]], saturday: [[360, 1455]], sunday: [[360, 1455]] } };
        expect(hoursSummary({ sections: [], hours: gs }).detail).toBe('About 6 AM to 12:15 AM.');
    });

    it('tells weekday-only lines from rush-hour-only ones', () => {
        const b = { days: ['weekday'], night: false, spans: { weekday: [[315, 1350]] } };
        const z = { days: ['weekday'], night: false, spans: { weekday: [[435, 555], [1005, 1125]] } };
        expect(hoursSummary({ sections: [], hours: b })).toMatchObject({ text: 'Weekdays only', detail: 'About 5:15 AM to 10:30 PM.' });
        expect(hoursSummary({ sections: [], hours: z })).toMatchObject({
            text: 'Weekday rush hours only', detail: 'About 7:15 AM to 9:15 AM and 4:45 PM to 6:45 PM.',
        });
    });

    it('gives nothing for a line without hours', () => {
        expect(hoursSummary({ sections: [['a']] })).toBeNull();
    });
});

describe('hoursTag', () => {
    it('tags only the exceptions', () => {
        expect(hoursTag(lineOrder.A, 'A41')).toBeNull();
        expect(hoursTag(lineOrder.C, 'A41')).toEqual({ text: 'No late nights', tone: 'limited' });
        expect(hoursTag(lineOrder.R, 'R29')).toBeNull();
        expect(hoursTag(lineOrder.R, 'R31')).toEqual({ text: 'No late nights', tone: 'limited' });
    });

    it('shortens rush hours only for a tag', () => {
        const z = { sections: [], hours: { days: ['weekday'], night: false, spans: { weekday: [[435, 555], [1005, 1125]] } } };
        expect(hoursTag(z, 'x').text).toBe('Rush hours only');
    });
});

describe('stationModel', () => {
    it('gives the borough, entrances and one row per line, in trunk order', () => {
        const m = model();
        expect(m).toMatchObject({ name: 'Jay St-MetroTech', borough: 'Brooklyn', entrances: 17 });
        expect(m.rows.map(r => r.routeIds)).toEqual([['A', 'E'], ['C'], ['F'], ['R']]);
    });

    it('labels each side with MTA\'s direction names and links the neighbors', () => {
        const [ae] = model().rows;
        expect(ae.north).toEqual({ label: 'Manhattan', stops: [{ name: 'High St', path: '/station/940-high-st' }] });
        expect(ae.south.label).toBe('Outbound');
        expect(ae.south.stops[0].name).toBe('Hoyt-Schermerhorn Sts');
        expect(ae.tag).toBeNull();
    });

    it('keeps a line with different hours on a row of its own', () => {
        const c = model().rows.find(r => r.routeIds.includes('C'));
        expect(c.routeIds).toEqual(['C']);
        expect(c.tag).toEqual({ text: 'No late nights', tone: 'limited' });
    });

    it('names a neighbor as its platform is signed, and links its complex', () => {
        const signed = { R28: 'Court St' };
        const m = stationModel(jay, {
            meta, lineOrder, complexOf: (id) => (id === 'R28' ? { complexId: '620', name: 'Borough Hall' } : complexOf(id)),
            nameOf: (id) => signed[id],
        });
        const r = m.rows.find(row => row.routeIds.includes('R'));
        expect(r.north.stops).toEqual([{ name: 'Court St', path: '/station/620-borough-hall' }]);
    });

    it('uses the platform each line stops at for its direction names', () => {
        const r = model().rows.find(r => r.routeIds.includes('R'));
        expect(r.south.label).toBe('Southbound');
    });

    it('gives each side an empty time slot for its lines and platform direction', () => {
        const html = stationFactsHtml(model(), routeMap);
        expect(html).toContain('<a href="/station/940-high-st">High St</a> <span class="next-stop-time" data-lines="A E" data-dir="N"></span>');
        expect(html).toContain('<span class="next-stop-time" data-lines="A E" data-dir="S"></span>');
        expect(html).toContain('data-lines="C" data-dir="N"');
        expect(html.match(/class="next-stop-time"/g)).toHaveLength(8);
    });

    it('leaves out the slot on a side with no next stop', () => {
        const end = stationModel(jay, { meta, lineOrder: { A: { sections: [['A40', 'A41']], hours: ALL_NIGHT } }, complexOf });
        const html = stationFactsHtml(end, routeMap);
        expect(html).toContain('data-dir="N"');
        expect(html).not.toContain('data-dir="S"');
    });

    it('has no rows without a stop order, and nothing to show for them', () => {
        const bare = stationModel(jay, { meta, lineOrder: {}, complexOf });
        expect(bare.rows).toEqual([]);
        expect(stationFactsHtml(bare, routeMap)).toBe('');
    });
});

describe('stationPanelHtml', () => {
    it('makes an empty shell with every slot popup.js fills', () => {
        const html = stationPanelHtml(null);
        for (const slot of ['place-heading', 'popup-trunks', 'popup-alerts', 'popup-tabs', 'popup-arrivals', 'popup-note', 'place-facts', 'popup-close', 'place-back']) {
            expect(html).toContain(slot);
        }
        expect(html).not.toContain('<h1');
    });

    it('fills the heading and next stops when given a station', () => {
        const html = stationPanelHtml(model(), routeMap);
        expect(html).toContain('<h1 class="place-title" id="station-title">Jay St-MetroTech</h1>');
        expect(html).toContain('Brooklyn · 17 entrances');
        expect(html).toContain('href="/line/c"');
        expect(html).toContain('<a href="/station/940-high-st">High St</a>');
        expect(html).toContain('<span class="hours-tag hours-tag--limited">No late nights</span>');
    });

    it('escapes names from the data', () => {
        const odd = stationModel({ name: 'A & B <St>', stationIds: [] }, { meta, lineOrder: {}, complexOf });
        expect(stationHeadingHtml(odd)).toContain('A &amp; B &lt;St&gt;');
    });

    it('says "1 entrance" for one, and leaves the count out when unknown', () => {
        const one = stationModel(jay, { meta, lineOrder: {}, entrances: 1, complexOf });
        expect(stationHeadingHtml(one)).toContain('Brooklyn · 1 entrance<');
        expect(stationHeadingHtml(stationModel(jay, { meta, lineOrder: {}, complexOf }))).toContain('>Brooklyn</p>');
    });
});

describe('lineModel', () => {
    // The A's real sections, with every station but the Rockaway Park branch
    // served late at night, and a C that shares its first three stations.
    const { patterns, daytime } = fixture.lines.A;
    const sections = lineSections(patterns, new Set(daytime)).sections;
    const rockawayPark = sections.find(s => s.at(-1) === idNamed('Rockaway Park-Beach 116 St'));
    const night = [...new Set(sections.flat())].filter(id => !rockawayPark.slice(1).includes(id));
    const ids = Object.keys(fixture.names);
    const complexOf = (id) => ({ complexId: String(100 + ids.indexOf(id)), name: fixture.names[id], stationIds: [id] });
    const order = {
        A: { sections, hours: { days: ['weekday', 'saturday', 'sunday'], night } },
        C: { sections: [sections[0].slice(0, 3)], hours: C_HOURS },
    };
    const routes = { ...routeMap, A: { shortName: 'A', name: '8 Avenue Express', color: '#0062CF', desc: 'Trains operate <always>.' } };
    const a = () => lineModel('A', { lineOrder: order, routeMap: routes, complexOf, nameOf: (id) => fixture.names[id] });

    it('names the line and counts its stations', () => {
        expect(a()).toMatchObject({ id: 'A', name: 'A line', longName: '8 Avenue Express', stationCount: 44 });
    });

    it('lists every station once, naming each section by its ends', () => {
        const m = a();
        expect(m.sections.map(s => s.title)).toEqual([
            'Inwood-207 St to Rockaway Blvd',
            'Rockaway Blvd to Broad Channel',
            'Rockaway Blvd to Ozone Park-Lefferts Blvd',
            'Broad Channel to Far Rockaway-Mott Av',
            'Broad Channel to Rockaway Park-Beach 116 St',
        ]);
        const names = m.sections.flatMap(s => s.stops.map(stop => stop.name));
        expect(names).toHaveLength(44);
        expect(new Set(names).size).toBe(44);
        expect(m.sections[2].stops[0].name).not.toBe('Rockaway Blvd');
    });

    it('marks the stops the line skips late at night', () => {
        const m = a();
        const rp = m.sections.at(-1).stops;
        expect(rp.every(s => s.notLate)).toBe(true);
        expect(m.sections[0].stops.some(s => s.notLate)).toBe(false);
        expect(m.hours.text).toBe('24 hours');
    });

    it('leaves stops unmarked when only a short stretch runs late, which the hours line names', () => {
        const short = { ...order, A: { sections, hours: { days: ['weekday', 'saturday', 'sunday'], night: rockawayPark } } };
        const m = lineModel('A', { lineOrder: short, routeMap: routes, complexOf, nameOf: (id) => fixture.names[id] });
        expect(m.sections.flatMap(s => s.stops).some(s => s.notLate)).toBe(false);
        expect(m.hours.detail).toBe('Late at night, trains run only between Broad Channel and Rockaway Park-Beach 116 St.');
    });

    it('gives each stop the other lines that stop there, and a link', () => {
        const [inwood, , third] = a().sections[0].stops;
        expect(inwood.transfers).toEqual(['C']);
        expect(third.transfers).toEqual(['C']);
        expect(a().sections[0].stops[3].transfers).toEqual([]);
        expect(inwood.path).toBe(`/station/${complexOf(sections[0][0]).complexId}-inwood-207-st`);
    });

    it('leaves a single-section line untitled and a shuttle without a separate long name', () => {
        const g = lineModel('C', { lineOrder: order, routeMap: routes, complexOf });
        expect(g.sections.map(s => s.title)).toEqual(['']);
        expect(lineModel('GS', { lineOrder: {}, routeMap }).longName).toBe('');
    });

    it('still names a line with no stop order', () => {
        const bare = lineModel('A', { lineOrder: {}, routeMap: routes });
        expect(bare).toMatchObject({ name: 'A line', stationCount: 0, sections: [], hours: null });
        expect(lineFactsHtml(bare, routes)).not.toContain('line-stops');
        expect(lineFactsHtml(bare, routes)).toContain('Trains operate &lt;always&gt;.');
    });
});

describe('linePanelHtml', () => {
    it('makes an empty shell with the back link, close button and body', () => {
        const html = linePanelHtml(null, routeMap);
        for (const part of ['place-back', 'place-heading', 'popup-close', 'place-body']) expect(html).toContain(part);
        expect(html).not.toContain('<h1');
    });

    it('fills the heading, hours, description, status slot and stops', () => {
        const { patterns, daytime } = fixture.lines.A;
        const sections = lineSections(patterns, new Set(daytime)).sections;
        const order = { A: { sections, hours: { days: ['weekday'], night: true } }, C: { sections: [sections[0].slice(0, 2)] } };
        const complexOf = (id) => ({ complexId: '1', name: fixture.names[id], stationIds: [id] });
        const routes = { ...routeMap, A: { shortName: 'A', name: '8 Avenue Express', color: '#0062CF', desc: 'Runs & runs.' } };
        const html = linePanelHtml(lineModel('A', { lineOrder: order, routeMap: routes, complexOf }), routes);

        expect(html).toContain('<h1 class="place-title" id="line-title">A line</h1>');
        expect(html).toContain('aria-hidden="true">A</span>');
        expect(html).toContain('8 Avenue Express · 44 stations');
        expect(html).toContain('<span class="hours-tag hours-tag--ok">24 hours</span>');
        expect(html).toContain('<p class="line-desc">Runs &amp; runs.</p>');
        expect(html).toContain('class="line-more hidden"');
        expect(html).toContain('<div class="line-status" aria-live="polite"></div>');
        expect(html).toContain('Stops from the north end');
        expect(html).toContain('<a href="/station/1-inwood-207-st">Inwood-207 St</a>');
        expect(html).toContain('aria-label="Transfer to C"');
        expect(html).toContain('<ol class="line-stops" style="--line:#0062CF">');
    });
});

function idNamed(name) {
    return Object.keys(fixture.names).find(id => fixture.names[id] === name);
}
