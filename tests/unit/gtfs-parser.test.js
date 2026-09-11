import { describe, it, expect } from 'vitest';
import {
    splitCSVLine,
    parseCSV,
    parseRoutes,
    parseStops,
    parseShapes,
    parseTripsToRouteShapes,
    parseGTFS,
    buildStationComplexes,
    MTA_ROUTE_COLORS,
} from '../../src/core/gtfs-parser.js';

// ---------------------------------------------------------------------------
// splitCSVLine
// ---------------------------------------------------------------------------

describe('splitCSVLine', () => {
    it('splits a plain comma-separated line into an array of strings', () => {
        expect(splitCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('does not split on a comma inside a quoted field', () => {
        expect(splitCSVLine('"8 Avenue, Express",A,Blue')).toEqual(['8 Avenue, Express', 'A', 'Blue']);
    });

    it('handles an escaped double-quote ("") inside a quoted field -> single "', () => {
        expect(splitCSVLine('"say ""hello""",world')).toEqual(['say "hello"', 'world']);
    });

    it('handles an empty field between two commas', () => {
        expect(splitCSVLine('a,,c')).toEqual(['a', '', 'c']);
    });
});

// ---------------------------------------------------------------------------
// parseCSV
// ---------------------------------------------------------------------------

describe('parseCSV', () => {
    it('strips a leading UTF-8 BOM (\\uFEFF) from the header row', () => {
        const csv = '﻿name,value\nfoo,bar';
        const rows = parseCSV(csv);
        expect(rows[0]).toHaveProperty('name', 'foo');
        expect(rows[0]).not.toHaveProperty('﻿name');
    });

    it('handles CRLF line endings without including \\r in field values', () => {
        const csv = 'name,value\r\nfoo,bar\r\n';
        const rows = parseCSV(csv);
        expect(rows[0].name).toBe('foo');
        expect(rows[0].value).toBe('bar');
    });

    it('returns one object per data row keyed by header names', () => {
        const csv = 'id,name\n1,Alice\n2,Bob';
        const rows = parseCSV(csv);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({ id: '1', name: 'Alice' });
        expect(rows[1]).toEqual({ id: '2', name: 'Bob' });
    });

    it('skips blank lines and does not include them in the result', () => {
        const csv = 'id,name\n1,Alice\n\n2,Bob\n';
        const rows = parseCSV(csv);
        expect(rows).toHaveLength(2);
    });

    it('handles quoted fields with interior commas', () => {
        const csv = 'id,name\n1,"8 Avenue, Express"';
        const rows = parseCSV(csv);
        expect(rows[0].name).toBe('8 Avenue, Express');
    });
});

// ---------------------------------------------------------------------------
// parseRoutes
// ---------------------------------------------------------------------------

describe('parseRoutes', () => {
    const makeRoutes = (...rows) =>
        ['route_id,route_short_name,route_long_name,route_color,route_text_color', ...rows].join('\n');

    it('prefixes route_color with # when the field is non-empty', () => {
        const result = parseRoutes(makeRoutes('1,1,Broadway Local,EE352E,FFFFFF'));
        expect(result['1'].color).toBe('#EE352E');
    });

    it('falls back to MTA_ROUTE_COLORS when route_color is blank', () => {
        const result = parseRoutes(makeRoutes('A,A,8 Avenue Express,,FFFFFF'));
        expect(result['A'].color).toBe(MTA_ROUTE_COLORS['A']);
    });

    it('falls back to #808183 when neither route_color nor MTA_ROUTE_COLORS has a match', () => {
        const result = parseRoutes(makeRoutes('XX,XX,Unknown Line,,'));
        expect(result['XX'].color).toBe('#808183');
    });

    it('skips rows with no route_id', () => {
        const result = parseRoutes(makeRoutes(',1,Broadway Local,EE352E,FFFFFF'));
        expect(Object.keys(result)).toHaveLength(0);
    });

    it('sets textColor from route_text_color when present', () => {
        const result = parseRoutes(makeRoutes('1,1,Broadway Local,EE352E,000000'));
        expect(result['1'].textColor).toBe('#000000');
    });

    it('defaults textColor to #FFFFFF when route_text_color is blank', () => {
        const result = parseRoutes(makeRoutes('1,1,Broadway Local,EE352E,'));
        expect(result['1'].textColor).toBe('#FFFFFF');
    });
});

// ---------------------------------------------------------------------------
// parseStops
// ---------------------------------------------------------------------------

describe('parseStops', () => {
    const makeStops = (...rows) =>
        ['stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station', ...rows].join('\n');

    it('includes parent stations (location_type === "1")', () => {
        const { stations } = parseStops(makeStops('127,Times Sq-42 St,40.75529,-73.98794,1,'));
        expect(stations).toHaveLength(1);
        expect(stations[0].id).toBe('127');
    });

    it('includes orphan stops (no parent_station and location_type !== "2")', () => {
        const { stations } = parseStops(makeStops('A27,Howard Beach,40.66074,-73.83286,0,'));
        expect(stations).toHaveLength(1);
        expect(stations[0].id).toBe('A27');
    });

    it('excludes child platforms (location_type === "0" with a parent_station)', () => {
        const { stations } = parseStops(makeStops('127N,Times Sq-42 St,40.75529,-73.98794,0,127'));
        expect(stations).toHaveLength(0);
    });

    it('excludes station entrances (location_type === "2")', () => {
        const { stations } = parseStops(makeStops('127E1,Times Sq Entrance,40.75529,-73.98794,2,127'));
        expect(stations).toHaveLength(0);
    });

    it('builds childToParent: maps child stop_id to its parent_station value', () => {
        const { childToParent } = parseStops(makeStops('127N,Times Sq-42 St,40.75529,-73.98794,0,127'));
        expect(childToParent['127N']).toBe('127');
    });

    it('builds childToParent for both directional platforms', () => {
        const { childToParent } = parseStops(
            makeStops(
                '127,Times Sq-42 St,40.75529,-73.98794,1,',
                '127N,Times Sq-42 St,40.75529,-73.98794,0,127',
                '127S,Times Sq-42 St,40.75529,-73.98794,0,127',
            )
        );
        expect(childToParent['127N']).toBe('127');
        expect(childToParent['127S']).toBe('127');
    });

    it('skips rows where lat or lng is not a valid float', () => {
        const { stations } = parseStops(makeStops('BAD,Bad Stop,notanumber,alsobad,1,'));
        expect(stations).toHaveLength(0);
    });

    it('parses lat and lng as floats', () => {
        const { stations } = parseStops(makeStops('127,Times Sq-42 St,40.75529,-73.98794,1,'));
        expect(stations[0].lat).toBeCloseTo(40.75529);
        expect(stations[0].lng).toBeCloseTo(-73.98794);
    });
});

// ---------------------------------------------------------------------------
// parseShapes
// ---------------------------------------------------------------------------

describe('parseShapes', () => {
    const makeShapes = (...rows) =>
        ['shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence', ...rows].join('\n');

    it('groups rows by shape_id', () => {
        const result = parseShapes(makeShapes(
            'A_NORTH,40.86783,-73.92595,1',
            'A_NORTH,40.86413,-73.92870,2',
            'B_SOUTH,40.76783,-73.82595,1',
        ));
        expect(Object.keys(result)).toHaveLength(2);
        expect(result['A_NORTH']).toHaveLength(2);
        expect(result['B_SOUTH']).toHaveLength(1);
    });

    it('sorts each group ascending by shape_pt_sequence', () => {
        const result = parseShapes(makeShapes(
            'A_NORTH,40.80000,-73.90000,3',
            'A_NORTH,40.86783,-73.92595,1',
            'A_NORTH,40.83000,-73.91000,2',
        ));
        expect(result['A_NORTH'].map(p => p.seq)).toEqual([1, 2, 3]);
    });

    it('parses shape_pt_sequence as an integer', () => {
        const result = parseShapes(makeShapes('A_NORTH,40.86783,-73.92595,001'));
        expect(result['A_NORTH'][0].seq).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// parseTripsToRouteShapes
// ---------------------------------------------------------------------------

describe('parseTripsToRouteShapes', () => {
    const makeTrips = (...rows) =>
        ['route_id,service_id,trip_id,shape_id', ...rows].join('\n');

    const shapePoints = {
        A_LONG: [
            { lat: 40.1, lng: -73.1, seq: 1 },
            { lat: 40.2, lng: -73.2, seq: 2 },
            { lat: 40.3, lng: -73.3, seq: 3 },
        ],
        A_SHORT: [
            { lat: 40.1, lng: -73.1, seq: 1 },
            { lat: 40.2, lng: -73.2, seq: 2 },
        ],
        G_MAIN: [
            { lat: 40.5, lng: -73.9, seq: 1 },
            { lat: 40.6, lng: -73.8, seq: 2 },
        ],
        // A trunk and a branch that diverge, both long enough to clear
        // MIN_COVER_GAIN_CELLS. The gain is counted in occupied cells, so a
        // two-point shape in new territory still earns nothing.
        TRUNK: Array.from({ length: 20 }, (_, i) => ({
            lat: 41.0 + i * 0.01, lng: -72.0, seq: i + 1,
        })),
        BRANCH: Array.from({ length: 16 }, (_, i) => ({
            lat: 41.0 + i * 0.01, lng: -71.5, seq: i + 1,
        })),
        // Runs along TRUNK's first half, so it covers nothing new.
        TRUNK_SHORT: Array.from({ length: 10 }, (_, i) => ({
            lat: 41.0 + i * 0.01, lng: -72.0, seq: i + 1,
        })),
        // A shape too short to draw. Nothing downstream can render a single
        // point, so it should not produce a polyline at all.
        STUB: [
            { lat: 40.7, lng: -73.7, seq: 1 },
        ],
    };

    it('starts from the shape with the most points', () => {
        const result = parseTripsToRouteShapes(
            makeTrips('A,Weekday,trip1,A_LONG', 'A,Weekday,trip2,A_SHORT'),
            shapePoints,
        );
        expect(result['A'][0]).toHaveLength(3);
    });

    it('returns polylines per route, as an array', () => {
        const result = parseTripsToRouteShapes(
            makeTrips('A,Weekday,trip1,A_LONG'),
            shapePoints,
        );
        expect(Array.isArray(result['A'])).toBe(true);
        expect(result['A']).toHaveLength(1);
        expect(Array.isArray(result['A'][0])).toBe(true);
    });

    it('drops a short-turn that covers no new ground', () => {
        // This is what stops every short-turn pattern in the feed from becoming
        // its own overlapping polyline.
        const result = parseTripsToRouteShapes(
            makeTrips('A,Weekday,trip1,TRUNK', 'A,Weekday,trip2,TRUNK_SHORT'),
            shapePoints,
        );
        expect(result['A']).toHaveLength(1);
        expect(result['A'][0]).toHaveLength(20);
    });

    it('keeps a branch that goes somewhere the trunk does not', () => {
        const result = parseTripsToRouteShapes(
            makeTrips('A,Weekday,trip1,TRUNK', 'A,Weekday,trip2,BRANCH'),
            shapePoints,
        );
        expect(result['A']).toHaveLength(2);
        // Longest first, so the branch is second.
        expect(result['A'][0]).toHaveLength(20);
        expect(result['A'][1]).toHaveLength(16);
    });

    it('drops a shape too short to draw', () => {
        const result = parseTripsToRouteShapes(makeTrips('S,Weekday,trip1,STUB'), shapePoints);
        expect(result['S']).toBeUndefined();
    });

    it('returns coordinates as [lat, lng] pairs', () => {
        const result = parseTripsToRouteShapes(
            makeTrips('G,Weekday,trip1,G_MAIN'),
            shapePoints,
        );
        expect(result['G'][0][0]).toEqual([40.5, -73.9]);
    });

    it('skips rows with missing route_id or shape_id', () => {
        const result = parseTripsToRouteShapes(
            makeTrips(',Weekday,trip1,A_LONG', 'A,Weekday,trip2,'),
            shapePoints,
        );
        expect(Object.keys(result)).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// parseGTFS (integration)
// ---------------------------------------------------------------------------

describe('parseGTFS', () => {
    it('returns all expected keys', () => {
        const stops  = 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n127,Times Sq,40.755,-73.987,1,';
        const routes = 'route_id,route_short_name,route_long_name,route_color,route_text_color\n1,1,Broadway Local,EE352E,FFFFFF';
        const shapes = 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n1N04R,40.867,-73.925,1\n1N04R,40.855,-73.930,2';
        const trips  = 'route_id,service_id,trip_id,shape_id\n1,Weekday,trip1,1N04R';

        const result = parseGTFS(stops, routes, shapes, trips);
        expect(result).toHaveProperty('stations');
        expect(result).toHaveProperty('childToParent');
        expect(result).toHaveProperty('routeMap');
        expect(result).toHaveProperty('lineRoutes');
    });

    it('wires parsers together correctly — station and route appear in output', () => {
        const stops  = 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n127,Times Sq,40.755,-73.987,1,';
        const routes = 'route_id,route_short_name,route_long_name,route_color,route_text_color\n1,1,Broadway Local,EE352E,FFFFFF';
        const shapes = 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n1N04R,40.867,-73.925,1\n1N04R,40.855,-73.930,2';
        const trips  = 'route_id,service_id,trip_id,shape_id\n1,Weekday,trip1,1N04R';

        const { stations, routeMap, lineRoutes } = parseGTFS(stops, routes, shapes, trips);
        expect(stations[0].id).toBe('127');
        expect(routeMap['1'].color).toBe('#EE352E');
        expect(lineRoutes['1']).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// MTA_ROUTE_COLORS
// ---------------------------------------------------------------------------

describe('MTA_ROUTE_COLORS', () => {
    it('covers all key lines', () => {
        const required = ['1', '4', 'A', 'B', 'F', 'G', 'J', 'L', 'N', '7', 'GS'];
        required.forEach(line => {
            expect(MTA_ROUTE_COLORS).toHaveProperty(line);
        });
    });

    it('all values are valid 6-digit hex colors', () => {
        Object.values(MTA_ROUTE_COLORS).forEach(color => {
            expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
        });
    });
});

describe('buildStationComplexes — grouping by MTA complex id', () => {
    // The real failure: six separate "86 St" stations, 21.8 km apart, from the
    // Upper West Side to Bay Ridge. Name grouping merged them into one complex,
    // which put its dot at a meaningless centroid and made the popup fetch and
    // interleave arrivals from all six.
    const eightySixSts = [
        { id: '121', name: '86 St', lat: 40.788644, lng: -73.976218 },  // 1
        { id: '626', name: '86 St', lat: 40.779492, lng: -73.955589 },  // 4/5/6
        { id: 'A20', name: '86 St', lat: 40.785672, lng: -73.968916 },  // A/C
        { id: 'N10', name: '86 St', lat: 40.622687, lng: -74.028398 },  // N/W, Bay Ridge
        { id: 'Q04', name: '86 St', lat: 40.777861, lng: -73.951669 },  // Q
        { id: 'R44', name: '86 St', lat: 40.592721, lng: -73.977050 },  // R, Brooklyn
    ];
    const complexId = new Map([
        ['121', '311'], ['626', '397'], ['A20', '158'],
        ['N10', '79'],  ['Q04', '476'], ['R44', '38'],
    ]);

    it('keeps same-named stations apart when their complex ids differ', () => {
        const out = buildStationComplexes(eightySixSts, complexId);
        expect(out).toHaveLength(6);
        for (const c of out) expect(c.stationIds).toHaveLength(1);
    });

    it('merged them into one before, which is the bug being fixed', () => {
        const out = buildStationComplexes(eightySixSts);   // no metadata
        expect(out).toHaveLength(1);
        expect(out[0].stationIds).toHaveLength(6);
    });

    it('still groups platforms that genuinely share a complex', () => {
        const timesSq = [
            { id: '127', name: 'Times Sq-42 St', lat: 40.75529,  lng: -73.987495 },
            { id: '725', name: 'Times Sq-42 St', lat: 40.755477, lng: -73.987691 },
            { id: '902', name: 'Times Sq-42 St', lat: 40.755983, lng: -73.986229 },
            { id: 'R16', name: 'Times Sq-42 St', lat: 40.754672, lng: -73.986754 },
        ];
        const ids = new Map(timesSq.map(s => [s.id, '611']));
        const out = buildStationComplexes(timesSq, ids);
        expect(out).toHaveLength(1);
        expect(out[0].stationIds.sort()).toEqual(['127', '725', '902', 'R16']);
        expect(out[0].name).toBe('Times Sq-42 St');
    });

    it('falls back to name grouping for stations the metadata omits', () => {
        const stations = [
            { id: 'A', name: 'Shared', lat: 1, lng: 1 },
            { id: 'B', name: 'Shared', lat: 1, lng: 1 },
        ];
        const out = buildStationComplexes(stations, new Map());
        expect(out).toHaveLength(1);
    });

    it('never collides a complex id with a station name', () => {
        // A station literally named "611" must not join complex 611.
        const stations = [
            { id: 'X', name: '611', lat: 1, lng: 1 },
            { id: 'Y', name: 'Elsewhere', lat: 2, lng: 2 },
        ];
        const out = buildStationComplexes(stations, new Map([['Y', '611']]));
        expect(out).toHaveLength(2);
    });

    it('averages coordinates within a complex', () => {
        const out = buildStationComplexes(
            [{ id: 'A', name: 'N', lat: 0, lng: 0 }, { id: 'B', name: 'N', lat: 2, lng: 4 }],
            new Map([['A', '1'], ['B', '1']]),
        );
        expect(out[0].lat).toBe(1);
        expect(out[0].lng).toBe(2);
    });
});
