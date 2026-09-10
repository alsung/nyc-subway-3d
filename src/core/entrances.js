// src/core/entrances.js
// Street entrances and exits, from MTA's own dataset.
//
// Keyed on complex_id rather than the gtfs_stop_id the rest of the app uses.
// Three source rows carry a compound id ("A32; D20") for an entrance shared
// between two stations, so an equality join on the stop id silently drops them
// and strands Times Sq's 7 platform, Union Sq, Fulton St and both Broadway
// Junctions. By complex the join is 445 of 445, and it is the truthful level
// anyway: you enter a complex, not a platform.
//
// What this deliberately does not model is the inside of a station. MTA
// publishes no floor plans, no mezzanines, and nothing connecting one platform
// to another, so a cutaway cannot be built from open data. The answerable
// question is the one you have standing on the sidewalk: which stair, and can
// I get in through it.

// Thirteen source values collapse to six. The distinctions the source draws
// between a Stair, a Stair/Escalator and a Stair/Ramp/Walkway do not change
// what a rider does, and drawing six symbols where two would do makes the map
// harder to read rather than more informative.
const TYPE_ALIASES = {
    'Stair': 'stair',
    'Stair/Escalator': 'stair',
    'Stair/Ramp': 'stair',
    'Stair/Ramp/Walkway': 'stair',
    'Elevator': 'elevator',
    'Escalator': 'escalator',
    'Ramp': 'ramp',
    'Station House': 'house',
    'Easement - Street': 'street',
    'Easement - Passage': 'passage',
    'Underpass': 'passage',
    'Walkway': 'passage',
    'Overpass': 'passage',
};

export const ENTRANCE_TYPES = ['stair', 'elevator', 'escalator', 'ramp', 'house', 'street', 'passage'];

/** An unfamiliar type still gets drawn, as the most common kind. */
export function normalizeType(sourceType) {
    return TYPE_ALIASES[sourceType] ?? 'stair';
}

/**
 * Turns the downloaded rows into entrance objects.
 *
 * The download script has already trimmed the portal's fifteen fields to five
 * and coerced the YES/NO strings, so this is mostly type normalization and
 * defensive dropping of rows that cannot be placed on a map.
 *
 * @param {{c: string, y: number, x: number, t: string, i: number, o: number}[]} rows
 * @returns {{complexId: string, lat: number, lng: number, type: string,
 *            entry: boolean, exit: boolean}[]}
 */
export function parseEntrances(rows) {
    if (!Array.isArray(rows)) return [];

    const out = [];
    for (const r of rows) {
        const lat = Number(r?.y);
        const lng = Number(r?.x);
        if (!r?.c || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        out.push({
            complexId: String(r.c),
            lat,
            lng,
            type: normalizeType(r.t),
            // Both flags default true: a row that fails to say is far more
            // likely to be an ordinary entrance than a one-way exit, and
            // marking a usable entrance "exit only" sends someone the long way
            // round for nothing.
            entry: r.i !== 0,
            exit: r.o !== 0,
        });
    }
    return out;
}

/**
 * Groups entrances by the complex they serve.
 *
 * @param {ReturnType<typeof parseEntrances>} entrances
 * @returns {Map<string, ReturnType<typeof parseEntrances>>}
 */
export function indexByComplex(entrances) {
    const index = new Map();
    for (const e of entrances ?? []) {
        const list = index.get(e.complexId);
        if (list) list.push(e);
        else index.set(e.complexId, [e]);
    }
    return index;
}

/**
 * The label a rider needs, or null when the entrance says nothing useful.
 *
 * Only about 175 of 2,120 entrances carry one. An ordinary two-way stair is
 * what people expect a subway entrance to be, so labelling all 1,629 of them
 * would bury the hundred that matter. Exit-only wins over the type, because
 * walking to a stair you cannot enter is the costlier mistake.
 */
export function entranceLabel(entrance) {
    if (!entrance) return null;
    if (!entrance.entry) return 'Exit only';
    if (entrance.type === 'elevator') return 'Elevator';
    if (entrance.type === 'escalator') return 'Escalator';
    return null;
}
