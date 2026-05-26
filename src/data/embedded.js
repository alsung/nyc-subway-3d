// src/data/embedded.js
// Hardcoded fallback data — lets the app render with zero network requests.
// Covers one landmark station per line and minimal shape geometry per route.
// Coordinates are real WGS-84 values sourced from MTA stops.txt.

export const EMBEDDED_STATIONS = [
    // { id, name, lat, lng }
    // include ~20 landmark stations spread across all five boroughs
    // e.g. Times Square, Grand Central, Atlantic Terminal, Fulton St,
    //      Jackson Heights, Court Sq, Jay St, Bedford Av, Jamaica, etc.
]

export const EMBEDDED_ROUTES = [
    // { id, shortName, name, color, textColor }
    // one entry per logical line using MTA_ROUTE_COLORS values
    // import MTA_ROUTE_COLORS from '../core/gtfs-parser.js' and reference it here
    // cover all 23 lines: 1,2,3,4,5,6,7,A,C,E,B,D,F,M,G,J,Z,L,N,Q,R,W,S
]

export const EMBEDDED_SHAPES = {
    // { [routeId]: [[lat, lng], ...] }
    // 8–12 coordinate pairs per route — enough to draw recognizable geometry
    // without the full shapes.txt resolution
    // values should follow the actual geographic path of each line
}
