// src/core/platforms.js
// Station platform footprints, from OpenStreetMap.
//
// MTA publishes no station interiors — its GTFS feed carries neither
// pathways.txt nor levels.txt — so this is the one part of a station's shape
// that can be drawn from open data. A spike measured what OSM actually has
// before any of it was built: platform polygons at 496 of 496 stations, levels
// at 476, and essentially no usable interior detail (84 of 445 complexes carry
// any structural indoor feature, exactly two carry real detail).
//
// So this is platform layout, not a cutaway. It answers "what shape is this
// station and how are its platforms stacked", not "which corridor connects
// them".

// Meters of depth per storey.
//
// OSM's `level` is a storey index, not a distance: 191 St, the deepest station
// in the system at roughly 55 m, is tagged level -2, and so is shallow Wall St.
// Both simply have two floors. So depth here is a drawing convention that shows
// a station's internal *ordering* truthfully and its absolute depth not at all.
export const METERS_PER_LEVEL = 6;

/**
 * Where a level sits, in meters relative to street.
 *
 * Negative is underground. Positive levels are elevated track, and those the
 * feed gets right — Smith-9 Sts at level 4 genuinely is the highest station in
 * the system.
 */
export function depthForLevel(level, metersPerLevel = METERS_PER_LEVEL) {
    const n = Number(level);
    if (!Number.isFinite(n)) return 0;
    return n * metersPerLevel;
}

/**
 * Turns the downloaded rows into platform objects.
 *
 * @param {{c: string, l: number|null, g: [number, number][]}[]} rows
 * @returns {{complexId: string, level: number|null, ring: [number, number][]}[]}
 */
export function parsePlatforms(rows) {
    if (!Array.isArray(rows)) return [];

    const out = [];
    for (const r of rows) {
        // Three points is the minimum that encloses anything. A platform mapped
        // as a line rather than an area cannot be drawn as a footprint.
        if (!r?.c || !Array.isArray(r.g) || r.g.length < 3) continue;
        out.push({
            complexId: String(r.c),
            level: r.l === null || r.l === undefined ? null : Number(r.l),
            ring: r.g,
        });
    }
    return out;
}

/** Groups platforms by the complex they belong to. */
export function indexByComplex(platforms) {
    const index = new Map();
    for (const p of platforms ?? []) {
        const list = index.get(p.complexId);
        if (list) list.push(p);
        else index.set(p.complexId, [p]);
    }
    return index;
}

/**
 * The distinct levels a complex spans, deepest first.
 *
 * Platforms with no level tag sort last rather than being treated as street
 * level, which would stack them on top of a mezzanine they may sit below.
 */
export function levelsOf(platforms) {
    const levels = new Set();
    for (const p of platforms ?? []) {
        if (p.level !== null && Number.isFinite(p.level)) levels.add(p.level);
    }
    return [...levels].sort((a, b) => a - b);
}
