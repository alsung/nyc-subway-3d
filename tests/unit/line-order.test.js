import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    linePatterns, daytimeStations, lineSections, neighbors, buildLineOrder, serviceDays, lineHours,
    linesByStation, linesKey,
} from '../../src/core/line-order.js';

// Real patterns for the G, A and 5, from scripts/build-line-order-fixture.mjs.
// Committed, so these run in CI, which has no GTFS data.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/line-order-feed.json', import.meta.url), 'utf8'));

// stop_times, trips and stops rows for made-up trips, each given as
// [route id, direction id, platform ids in the order the train visits them].
// A platform's parent station is its id without the N or S.
function feed(trips) {
    const stopTimes = [];
    const tripRows = [];
    const platforms = new Set();
    trips.forEach(([route, direction, ids], n) => {
        const tripId = `trip-${n}`;
        tripRows.push({ trip_id: tripId, route_id: route, direction_id: String(direction) });
        ids.forEach((id, i) => {
            stopTimes.push({ trip_id: tripId, stop_id: id, stop_sequence: String(i + 1) });
            platforms.add(id);
        });
    });
    const stops = [...platforms].map(id => ({ stop_id: id, parent_station: id.replace(/[NS]$/, '') }));
    return { stopTimes, trips: tripRows, stops };
}

const all = (...ids) => new Set(ids);

describe('linePatterns', () => {
    it('reads every trip from the north end, so both directions give one pattern', () => {
        const { stopTimes, trips, stops } = feed([
            ['G', 1, ['aS', 'bS', 'cS']],
            ['G', 0, ['cN', 'bN', 'aN']],
        ]);
        expect(linePatterns(stopTimes, trips, stops).get('G')).toEqual([['a', 'b', 'c']]);
    });

    it('orders stops by stop_sequence, whatever order the rows arrive in', () => {
        const { stopTimes, trips, stops } = feed([['G', 1, ['aS', 'bS', 'cS', 'dS']]]);
        expect(linePatterns(stopTimes.reverse(), trips, stops).get('G')).toEqual([['a', 'b', 'c', 'd']]);
    });

    it('folds an express route into its line, as the line URLs do', () => {
        const { stopTimes, trips, stops } = feed([
            ['6', 1, ['aS', 'bS', 'cS']],
            ['6X', 1, ['aS', 'cS']],
        ]);
        const patterns = linePatterns(stopTimes, trips, stops);
        expect(patterns.has('6X')).toBe(false);
        expect(patterns.get('6')).toEqual([['a', 'b', 'c'], ['a', 'c']]);
    });

    it('keeps a station once when two of its platforms are listed in a row', () => {
        const { stopTimes, trips, stops } = feed([['G', 1, ['aS', 'aN', 'bS']]]);
        expect(linePatterns(stopTimes, trips, stops).get('G')).toEqual([['a', 'b']]);
    });

    it('skips stop times for a trip trips.txt does not have', () => {
        const { stopTimes, trips, stops } = feed([['G', 1, ['aS', 'bS']]]);
        stopTimes.push({ trip_id: 'ghost', stop_id: 'aS', stop_sequence: '1' });
        expect([...linePatterns(stopTimes, trips, stops).keys()]).toEqual(['G']);
    });
});

describe('daytimeStations', () => {
    it('matches whole route names, so "S" does not pick up the SIR', () => {
        const rows = [
            { gtfs_stop_id: '901', daytime_routes: 'S' },
            { gtfs_stop_id: 'S09', daytime_routes: 'SIR' },
            { gtfs_stop_id: 'A02', daytime_routes: 'A' },
            { gtfs_stop_id: 'X', daytime_routes: undefined },
        ];
        expect(daytimeStations(rows, 'S')).toEqual(all('901'));
    });
});

describe('lineSections', () => {
    it('gives a straight line as one section', () => {
        expect(lineSections([['a', 'b', 'c']], all('a', 'b', 'c'))).toEqual({ sections: [['a', 'b', 'c']], fallback: false });
    });

    it('drops an express hop, leaving the local order', () => {
        const { sections } = lineSections([['a', 'b', 'c', 'd'], ['a', 'd']], all('a', 'b', 'c', 'd'));
        expect(sections).toEqual([['a', 'b', 'c', 'd']]);
    });

    it('collapses skip-stop runs, like the J and Z, into the local order', () => {
        const { sections } = lineSections([['a', 'b', 'd'], ['a', 'c', 'd'], ['a', 'b', 'c', 'd']], all('a', 'b', 'c', 'd'));
        expect(sections).toEqual([['a', 'b', 'c', 'd']]);
    });

    it('leaves out stations that are not on the daytime list', () => {
        const { sections } = lineSections([['a', 'b', 'night', 'c']], all('a', 'b', 'c'));
        expect(sections).toEqual([['a', 'b', 'c']]);
    });

    it('splits a branching line at the junction, longer branch first', () => {
        const { sections } = lineSections(
            [['n', 't', 'j', 'b1'], ['n', 't', 'j', 'c1', 'c2']],
            all('n', 't', 'j', 'b1', 'c1', 'c2'),
        );
        expect(sections).toEqual([['n', 't', 'j'], ['j', 'c1', 'c2'], ['j', 'b1']]);
    });

    it('handles two north ends joining, as the 5 does at E 180 St', () => {
        const { sections } = lineSections([['d1', 'd2', 'j', 's'], ['n1', 'j', 's']], all('d1', 'd2', 'n1', 'j', 's'));
        expect(sections).toEqual([['d1', 'd2', 'j'], ['n1', 'j'], ['j', 's']]);
    });

    it('falls back to the longest pattern when the stations loop back on themselves', () => {
        expect(lineSections([['a', 'b', 'c'], ['c', 'b']], all('a', 'b', 'c'))).toEqual({ sections: [['a', 'b', 'c']], fallback: true });
    });

    it('gives no sections when no station is on the daytime list', () => {
        expect(lineSections([['x', 'y']], all())).toEqual({ sections: [], fallback: false });
    });
});

describe('neighbors', () => {
    const sections = [['n', 't', 'j'], ['j', 'b1'], ['j', 'c1']];

    it('gives the stations either side of a station mid-line', () => {
        expect(neighbors(sections, 't')).toEqual({ prev: ['n'], next: ['j'] });
    });

    it('gives both branches at a junction', () => {
        expect(neighbors(sections, 'j')).toEqual({ prev: ['t'], next: ['b1', 'c1'] });
    });

    it('gives nothing before the north end', () => {
        expect(neighbors(sections, 'n')).toEqual({ prev: [], next: ['t'] });
    });

    it('gives two empty lists for a station the line does not stop at', () => {
        expect(neighbors(sections, 'elsewhere')).toEqual({ prev: [], next: [] });
    });
});

describe('buildLineOrder', () => {
    it('keeps each shuttle to its own stations, although MTA calls all three "S"', () => {
        const { stopTimes, trips, stops } = feed([
            ['GS', 1, ['g1S', 'g2S']],
            ['FS', 1, ['f1S', 'f2S', 'f3S']],
        ]);
        const routes = [{ route_id: 'GS', route_short_name: 'S' }, { route_id: 'FS', route_short_name: 'S' }];
        const stations = ['g1', 'g2', 'f1', 'f2', 'f3'].map(id => ({ gtfs_stop_id: id, daytime_routes: 'S' }));

        const { lines } = buildLineOrder({ stopTimes, trips, stops, routes, stations });
        expect(lines).toEqual({ FS: { sections: [['f1', 'f2', 'f3']] }, GS: { sections: [['g1', 'g2']] } });
    });

    it('leaves out a line with no daytime stations, and names it', () => {
        const { stopTimes, trips, stops } = feed([['G', 1, ['aS', 'bS']], ['NEW', 1, ['aS', 'bS']]]);
        const routes = [{ route_id: 'G', route_short_name: 'G' }, { route_id: 'NEW', route_short_name: 'NEW' }];
        const stations = [{ gtfs_stop_id: 'a', daytime_routes: 'G' }, { gtfs_stop_id: 'b', daytime_routes: 'G' }];

        const result = buildLineOrder({ stopTimes, trips, stops, routes, stations });
        expect(result.lines).toEqual({ G: { sections: [['a', 'b']] } });
        expect(result.empty).toEqual(['NEW']);
    });

    it('names a line that fell back to its longest pattern', () => {
        const { stopTimes, trips, stops } = feed([['G', 1, ['aS', 'bS', 'cS']], ['G', 1, ['cS', 'bS']]]);
        const stations = ['a', 'b', 'c'].map(id => ({ gtfs_stop_id: id, daytime_routes: 'G' }));

        const result = buildLineOrder({ stopTimes, trips, stops, routes: [{ route_id: 'G', route_short_name: 'G' }], stations });
        expect(result.fallbacks).toEqual(['G']);
        expect(result.lines.G.sections).toEqual([['a', 'b', 'c']]);
    });
});

describe('against the real feed', () => {
    const run = (line) => {
        const { patterns, daytime } = fixture.lines[line];
        return lineSections(patterns, new Set(daytime));
    };
    const named = (ids) => ids.map(id => fixture.names[id]);
    // The ends of the line: stations that start a section but never end one,
    // and the other way round.
    const ends = (sections) => {
        const firsts = new Set(sections.map(s => s[0]));
        const lasts = new Set(sections.map(s => s.at(-1)));
        return {
            north: named([...firsts].filter(id => !lasts.has(id))).sort(),
            south: named([...lasts].filter(id => !firsts.has(id))).sort(),
        };
    };

    it('gives the G as one run of 21 stations, Court Sq to Church Av', () => {
        const { sections, fallback } = run('G');
        expect(fallback).toBe(false);
        expect(sections).toHaveLength(1);
        expect(sections[0]).toHaveLength(21);
        expect(named([sections[0][0], sections[0].at(-1)])).toEqual(['Court Sq', 'Church Av']);
    });

    it('gives the A one north end and three south ends', () => {
        const { sections } = run('A');
        expect(ends(sections)).toEqual({
            north: ['Inwood-207 St'],
            south: ['Far Rockaway-Mott Av', 'Ozone Park-Lefferts Blvd', 'Rockaway Park-Beach 116 St'],
        });
        expect(named([sections[0][0], sections[0].at(-1)])).toEqual(['Inwood-207 St', 'Rockaway Blvd']);
    });

    it('joins the 5\'s Dyre Av and Nereid Av branches at E 180 St', () => {
        const { sections } = run('5');
        expect(ends(sections)).toEqual({
            north: ['Eastchester-Dyre Av', 'Nereid Av'],
            south: ['Flatbush Av-Brooklyn College'],
        });
        const e180 = Object.keys(fixture.names).find(id => fixture.names[id] === 'E 180 St');
        expect(neighbors(sections, e180).prev).toHaveLength(2);
    });

    it.each(['G', 'A', '5'])('puts every daytime station of the %s in a section, and none twice in one', (line) => {
        const { sections } = run(line);
        for (const section of sections) expect(new Set(section).size).toBe(section.length);
        expect(new Set(sections.flat())).toEqual(new Set(fixture.lines[line].daytime));
    });

    it('gives the same sections whatever order the patterns come in', () => {
        const { patterns, daytime } = fixture.lines.A;
        const shuffled = [...patterns].reverse();
        expect(lineSections(shuffled, new Set(daytime))).toEqual(run('A'));
    });
});

// Timed trips for the hours tests: [route, service, [[platform, "HH:MM"], ...]].
function timedFeed(trips) {
    const stopTimes = [];
    const tripRows = [];
    const platforms = new Set();
    trips.forEach(([route, service, stops], n) => {
        const tripId = `t-${n}`;
        tripRows.push({ trip_id: tripId, route_id: route, direction_id: '1', service_id: service });
        stops.forEach(([id, time], i) => {
            stopTimes.push({ trip_id: tripId, stop_id: id, stop_sequence: String(i + 1), departure_time: `${time}:00` });
            platforms.add(id);
        });
    });
    const stops = [...platforms].map(id => ({ stop_id: id, parent_station: id.replace(/[NS]$/, '') }));
    return { stopTimes, trips: tripRows, stops };
}

const CALENDAR = [
    { service_id: 'Weekday', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '0', sunday: '0' },
    { service_id: 'Saturday', monday: '0', tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '1', sunday: '0' },
    { service_id: 'Sunday', monday: '0', tuesday: '0', wednesday: '0', thursday: '0', friday: '0', saturday: '0', sunday: '1' },
];

describe('serviceDays', () => {
    it('reads which kinds of day each service runs from calendar.txt', () => {
        const days = serviceDays([...CALENDAR, { service_id: 'Fri', friday: '1' }]);
        expect(days.get('Weekday')).toEqual(new Set(['weekday']));
        expect(days.get('Sunday')).toEqual(new Set(['sunday']));
        expect(days.get('Fri')).toEqual(new Set(['weekday']));
    });
});

describe('lineHours', () => {
    const daytime = (line, ids) => new Map([[line, ids]]);

    it('marks a line with trains at every station late at night as all night', () => {
        const feed = timedFeed(['Weekday', 'Saturday', 'Sunday'].map(day => ['G', day, [['aS', '27:00'], ['bS', '27:05']]]));
        const hours = lineHours(feed.stopTimes, feed.trips, feed.stops, CALENDAR, daytime('G', ['a', 'b'])).get('G');
        expect(hours).toEqual({ days: ['weekday', 'saturday', 'sunday'], night: true });
    });

    it('lists the stations a line still reaches late at night, in its order', () => {
        const feed = timedFeed([
            ['5', 'Weekday', [['aS', '08:00'], ['bS', '08:05'], ['cS', '08:10'], ['dS', '08:15']]],
            ['5', 'Weekday', [['cS', '26:00'], ['dS', '26:05']]],
        ]);
        const hours = lineHours(feed.stopTimes, feed.trips, feed.stops, CALENDAR, daytime('5', ['a', 'b', 'c', 'd'])).get('5');
        expect(hours.night).toEqual(['c', 'd']);
        expect(hours).not.toHaveProperty('spans');
    });

    it('gives the hours of a line with no late-night trains, per kind of day', () => {
        const feed = timedFeed([
            ['C', 'Weekday', [['aS', '05:15'], ['bS', '05:20']]],
            ['C', 'Weekday', [['aS', '23:30'], ['bS', '23:40']]],
            ['C', 'Sunday', [['aS', '06:45'], ['bS', '06:50']]],
            ['C', 'Sunday', [['aS', '23:20'], ['bS', '23:25']]],
        ]);
        // A pause of more than an hour between these two weekday trips would be
        // a break, so fill the day with hourly service to keep it one span.
        for (let h = 6; h <= 23; h++) {
            const t = `${String(h).padStart(2, '0')}:00`;
            feed.stopTimes.push({ trip_id: 't-0', stop_id: 'aS', stop_sequence: '9', departure_time: `${t}:00` });
        }
        const hours = lineHours(feed.stopTimes, feed.trips, feed.stops, CALENDAR, daytime('C', ['a', 'b'])).get('C');
        expect(hours.days).toEqual(['weekday', 'sunday']);
        expect(hours.night).toBe(false);
        expect(hours.spans.weekday).toEqual([[315, 1425]]);
    });

    it('keeps a midday break as two spans, like the Z between rush hours', () => {
        const feed = timedFeed([
            ['Z', 'Weekday', [['aS', '07:15'], ['bS', '07:45'], ['aS', '08:30'], ['bS', '09:00']]],
            ['Z', 'Weekday', [['aS', '16:45'], ['bS', '17:30'], ['aS', '18:15'], ['bS', '18:40']]],
        ]);
        const hours = lineHours(feed.stopTimes, feed.trips, feed.stops, CALENDAR, daytime('Z', ['a', 'b'])).get('Z');
        expect(hours.days).toEqual(['weekday']);
        expect(hours.spans.weekday).toEqual([[435, 555], [1005, 1125]]);
    });

    it('folds an express route into its line', () => {
        const feed = timedFeed([['6X', 'Weekday', [['aS', '08:00'], ['bS', '08:10']]]]);
        const hours = lineHours(feed.stopTimes, feed.trips, feed.stops, CALENDAR, daytime('6', ['a', 'b']));
        expect([...hours.keys()]).toEqual(['6']);
    });
});

describe('buildLineOrder with a calendar', () => {
    it('adds each line\'s hours beside its sections', () => {
        const feed = timedFeed([['G', 'Weekday', [['aS', '27:00'], ['bS', '27:05']]]]);
        const stations = ['a', 'b'].map(id => ({ gtfs_stop_id: id, daytime_routes: 'G' }));
        const { lines } = buildLineOrder({
            ...feed, calendar: CALENDAR, routes: [{ route_id: 'G', route_short_name: 'G' }], stations,
        });
        expect(lines.G).toEqual({ sections: [['a', 'b']], hours: { days: ['weekday'], night: true } });
    });
});

describe('linesByStation and linesKey', () => {
    const order = {
        A: { sections: [['a1', 'j', 'a2'], ['j', 'a3']] },
        C: { sections: [['a1', 'j']] },
        G: { sections: [['g1', 'g2']] },
    };

    it('lists the lines that stop at each station, once each', () => {
        const byStation = linesByStation(order);
        expect(byStation.get('j')).toEqual(new Set(['A', 'C']));
        expect(byStation.get('a3')).toEqual(new Set(['A']));
        expect(byStation.has('nowhere')).toBe(false);
    });

    it('joins a complex\'s lines into one searchable string', () => {
        const byStation = linesByStation(order);
        expect(linesKey(['j'], byStation)).toBe('|A|C|');
        expect(linesKey(['a3', 'g1'], byStation)).toBe('|A|G|');
        expect(linesKey(['nowhere'], byStation)).toBe('');
        expect(linesKey(['j'], null)).toBe('');
    });
});
