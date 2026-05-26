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

export function parseTripsToRouteShapes(tripsText, shapePoints) {
    // parseCSV -> rows
    const rows = parseCSV(tripsText);

    // build routeToShapes: { [routeId]: Set of shapeIds }
    const routeToShapes = {};
    rows.forEach(r => {
        if (!r.route_id || !r.shape_id) return;
        if (!routeToShapes[r.route_id]) routeToShapes[r.route_id] = new Set();
        routeToShapes[r.route_id].add(r.shape_id);
    });

    // for each route, find the shape with the most points
    // return { [routeId]: [[lat, lng], ...] }
    const lineRoutes = {};
    for (const routeId in routeToShapes) {
        let bestShape = null;
        let bestCount = 0;
        for (const shapeId of routeToShapes[routeId]) {
            const pts = shapePoints[shapeId];
            if (pts && pts.length > bestCount) {
                bestCount = pts.length;
                bestShape = shapeId;
            }
        }
        if (bestShape) {
            lineRoutes[routeId] = shapePoints[bestShape].map(p => [p.lat, p.lng]);
        }
    }
    return lineRoutes;
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

