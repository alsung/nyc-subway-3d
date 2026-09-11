// src/core/gtfs-parser.js

export const MTA_ROUTE_COLORS = {
    '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
    '4': '#00933C', '5': '#00933C', '6': '#00933C', '6X': '#00933C',
    '7': '#B933AD', '7X': '#B933AD',
    'A': '#2850AD', 'C': '#2850AD', 'E': '#2850AD',
    'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'FX': '#FF6319','M': '#FF6319',
    'G': '#6CBE45',
    'J': '#996633', 'Z': '#996633',
    'L': '#A7A9AC',
    'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
    's': '#808183', 'GS': '#808183', 'FS': '#808183', 'H': '#808183', 'SI': '#808183',
}

export function splitCSVLine(line) {
    // track whether you're inside a quoted field
    // when you hit a comma outside quotes, push current and reset
    // when you hit "" inside quotes, emit a single "
    // push the final field after the loop
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                fields.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
    }
    fields.push(current);
    return fields;
}

export function parseCSV(text) {
    // split on \n
    const lines = text.split('\n');
    // strip \uFEFF BOM from first line
    lines[0] = lines[0].replace(/^\uFEFF/, '');
    // strip \r from each line
    // first line = headers
    const headers = splitCSVLine(lines[0].replace(/\r$/, ''));
    // remaining lines = rows - skip blank lines
    // for each row, zip headers with splitCSVLine values into an object
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        if (line === '') continue;
        const values = splitCSVLine(line);
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = values[j] ?? '';
        }
        rows.push(row);
    }
    return rows;
}

export function parseRoutes(routesText) {
    // parseCSV -> rows
    // for each row: build { id, name, shortName, color, textColor }
    // color: if route_color exists prepend #, else look up MTA_ROUTE_COLORS by short name, else '#808183'
    const rows = parseCSV(routesText);
    const routeMap = {};
    rows.forEach(r => {
        if (!r.route_id) return;
        routeMap[r.route_id] = {
            id: r.route_id,
            name: r.route_long_name,
            shortName: r.route_short_name,
            color: r.route_color ? `#${r.route_color}` : (MTA_ROUTE_COLORS[r.route_short_name] || '#808183'),
            textColor: r.route_text_color ? `#${r.route_text_color}` : '#FFFFFF',
        }
    })
    return routeMap;
}

export function parseStops(stopsText) {
    // parseCSV -> rows
    const rows = parseCSV(stopsText);
    const childToParent = {};
    const stations = [];

    // build childToParent map: if row has parent_station, map stop_id -> parent_station
    rows.forEach(r => {
        if (r.parent_station) childToParent[r.stop_id] = r.parent_station;
    });

    // keep row if location_type === '1' OR (no parent_station AND location_type !== '2')
    // for kept rows: parse lat/lng as floats, skip if NaN
    rows.forEach(r => {
        const isParent = r.location_type === '1';
        const isOrphan = !r.parent_station && r.location_type !== '2';
        if (!isParent && !isOrphan) return;
        const lat = parseFloat(r.stop_lat);
        const lng = parseFloat(r.stop_lon);
        if (isNaN(lat) || isNaN(lng)) return;
        stations.push({ id: r.stop_id, name: r.stop_name, lat, lng });
    });

    // return { stations: [], childToParent: {} }
    return { stations, childToParent };
}

export function parseShapes(shapesText) {
    // parseCSV -> rows
    const rows = parseCSV(shapesText);
    const shapes = {};

    // group by shape_id into { [shapeId]: [{lat, lng, seq}] }
    rows.forEach(r => {
        if (!shapes[r.shape_id]) shapes[r.shape_id] = [];
        shapes[r.shape_id].push({
            lat: parseFloat(r.shape_pt_lat),
            lng: parseFloat(r.shape_pt_lon),
            seq: parseInt(r.shape_pt_sequence, 10),
        });
    });

    // sort each group by shape_pt_sequence ascending
    for (const id in shapes) {
        shapes[id].sort((a, b) => a.seq - b.seq);
    }

    return shapes;
}

// Cell size for the coverage test, in degrees — about 65 m at this latitude.
// Coarse on purpose: two shapes along the same track are sampled at different
// points, so comparing them at meter precision would call every shape novel.
const COVER_CELL_DEG = 0.0006;

// A candidate shape must contribute at least this many new cells — roughly a
// kilometer of track — to earn its own polyline. Below that it is a short-turn
// or a slightly different approach to the same terminal, and drawing it adds
// overlapping geometry without adding any line to the map.
//
// Measured across the feed: 5 and 10 produce identical output, so this sits in
// the middle of a plateau rather than on a cliff.
const MIN_COVER_GAIN_CELLS = 10;

function cellsOf(points) {
    const out = new Set();
    for (const p of points) {
        out.add(`${Math.round(p.lat / COVER_CELL_DEG)},${Math.round(p.lng / COVER_CELL_DEG)}`);
    }
    return out;
}

/**
 * Chooses the fewest shapes that cover a route's whole extent.
 *
 * Start from the longest shape, then keep adding whichever remaining shape
 * contributes the most geometry the set does not already have, until the best
 * candidate is not worth its own polyline.
 *
 * Reversed duplicates fall out for free: every route has an N and an S shape
 * over the same track, and a reversal contributes no new cells.
 *
 * Across the feed this yields 38 polylines over 29 routes, with a single 65 m
 * cell unaccounted for system-wide.
 */
function coverRoute(shapeIds, shapePoints) {
    const candidates = [...shapeIds]
        .map(id => shapePoints[id])
        .filter(pts => pts?.length > 1)
        .sort((a, b) => b.length - a.length);

    if (!candidates.length) return [];

    // Cells are computed once per candidate, not once per comparison. The 5 has
    // 35 candidate shapes of ~600 points each and the loop below looks at every
    // remaining one on every pass, so recomputing here would be the difference
    // between a few milliseconds and a visible stall at startup.
    const cells = candidates.map(cellsOf);
    const taken = new Array(candidates.length).fill(false);

    taken[0] = true;
    const chosen = [candidates[0]];
    const covered = new Set(cells[0]);

    for (;;) {
        let best = -1;
        let bestGain = 0;

        for (let i = 0; i < candidates.length; i++) {
            if (taken[i]) continue;
            let gain = 0;
            for (const cell of cells[i]) if (!covered.has(cell)) gain++;
            if (gain > bestGain) { bestGain = gain; best = i; }
        }

        if (best === -1 || bestGain < MIN_COVER_GAIN_CELLS) break;
        taken[best] = true;
        chosen.push(candidates[best]);
        for (const cell of cells[best]) covered.add(cell);
    }

    return chosen;
}

/**
 * Route geometry, as one or more polylines per route.
 *
 * A route is not one line. The A has the Rockaway and Lefferts branches, the 5
 * has White Plains Rd, the 2 has Nostrand Av. Selecting a single shape left 51
 * stations with no line reaching them — every stop on the Rockaway branch among
 * them — while the stations still drew as dots, so the map looked complete and
 * was quietly missing track.
 *
 * Selecting a different single shape does not help: the most-frequent pattern
 * is usually a short-turn. The M's busiest shape is 9.5 km against the line's
 * 29.6, and the W's is half its length. The fix is to stop choosing one.
 *
 * @param {string} tripsText
 * @param {Record<string, {lat: number, lng: number}[]>} shapePoints
 * @returns {Record<string, [number, number][][]>} routeId -> polylines
 */
export function parseTripsToRouteShapes(tripsText, shapePoints) {
    const rows = parseCSV(tripsText);

    // { [routeId]: Set of shapeIds }
    const routeToShapes = {};
    rows.forEach(r => {
        if (!r.route_id || !r.shape_id) return;
        if (!routeToShapes[r.route_id]) routeToShapes[r.route_id] = new Set();
        routeToShapes[r.route_id].add(r.shape_id);
    });

    const lineRoutes = {};
    for (const routeId in routeToShapes) {
        const chosen = coverRoute(routeToShapes[routeId], shapePoints);
        if (chosen.length) {
            lineRoutes[routeId] = chosen.map(pts => pts.map(p => [p.lat, p.lng]));
        }
    }
    return lineRoutes;
}

// Merges same-name parent stations into complexes. Returns an array of
// { name, lat, lng, stationIds } where lat/lng is the centroid of the group.
// Separate GTFS parent entries for the same physical complex (e.g. the two
// "Times Sq-42 St" entries) collapse into one dot on the map.
/**
 * Groups platforms into the station complexes a rider treats as one place.
 *
 * complexId is a Map of GTFS stop id → MTA complex id, from stations.json. It
 * is the authority: a complex is what MTA says it is, not what shares a name.
 *
 * Name grouping was the original rule and was wrong in a way that reached the
 * arrivals a rider sees. NYC reuses station names heavily — there are six
 * separate "86 St" stations spanning 21.8 km, from the Upper West Side to Bay
 * Ridge — so grouping by name merged them into a single complex, put its dot at
 * a meaningless centroid, and made the popup fetch and interleave arrivals from
 * all six. Thirty-eight names covered platforms more than a kilometre apart.
 * Under complex ids, nothing spans more than 0.44 km.
 *
 * Falls back to name grouping when no metadata is supplied, because the
 * embedded-data path has none. That fallback is wrong in exactly the way
 * described above; it is retained only so a station map still renders when the
 * real data failed to load, which is already a degraded state.
 */
export function buildStationComplexes(stations, complexId = null) {
    const groups = new Map();

    for (const s of stations) {
        // Prefixed so a complex id can never collide with a station name.
        const key = complexId?.get(s.id)
            ? `cx:${complexId.get(s.id)}`
            : `name:${s.name}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
    }

    return [...groups.values()].map(group => ({
        name: group[0].name,
        lat: group.reduce((sum, s) => sum + s.lat, 0) / group.length,
        lng: group.reduce((sum, s) => sum + s.lng, 0) / group.length,
        stationIds: group.map(s => s.id),
    }));
}

export function parseGTFS(stopsText, routesText, shapesText, tripsText) {
    // call all four parsers
    const { stations, childToParent } = parseStops(stopsText);
    const routeMap = parseRoutes(routesText);
    // parseTripsToRouteShapes needs the shapePoints result from parseShapes
    const shapePoints = parseShapes(shapesText);
    const lineRoutes = parseTripsToRouteShapes(tripsText, shapePoints);
    // return { stations, routeMap, lineRoutes, childToParent }
    return { stations, childToParent, routeMap, lineRoutes };
}

