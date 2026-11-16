import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    escapeHtml, lineName, bulletSpec, bulletHtml, hoursSummary, hoursTag,
    stationModel, stationPanelHtml, stationHeadingHtml, stationFactsHtml,
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

describe('lineName', () => {
    it('names the shuttles by their long names, since all three are signed S', () => {
        expect(lineName('A', routeMap)).toBe('A line');
        expect(lineName('GS', routeMap)).toBe('42 St Shuttle');
        expect(lineName('Q9', routeMap)).toBe('Q9 line');
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

function idNamed(name) {
    return Object.keys(fixture.names).find(id => fixture.names[id] === name);
}
