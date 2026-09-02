// src/core/alert-text.js
// Splits MTA alert copy into text and route-bullet segments.
//
// Alert headers arrive with route bullets written as bracketed tokens:
//
//   "In Manhattan, [N] skips 28 St and 23 St - take the [Q] or [R] instead"
//
// The feed also ships an "en-html" translation carrying real markup, which this
// project deliberately never touches: it is third-party copy, and injecting it
// would hand MTA's feed direct DOM access. So the plain "en" text is tokenised
// here and the caller renders each segment itself — text through textContent,
// routes through its own bullet element.

// A token is 1-3 characters of A-Z or 0-9, which covers every MTA route id
// (1..7, A..Z, plus 6X/7X/FX/SIR). Anything else inside brackets is left as
// literal text rather than guessed at.
const TOKEN = /\[([A-Z0-9]{1,3})\]/g;

/**
 * Parses alert text into an ordered list of segments.
 *
 * Returns an array of `{ text }` and `{ route }` objects. Concatenating every
 * `text` and the original bracket form of every `route` reproduces the input,
 * so nothing is silently dropped.
 *
 * Unmatched brackets, empty brackets and lowercase content are all treated as
 * ordinary text — a malformed token should render as MTA wrote it rather than
 * disappear.
 */
export function parseAlertText(input) {
    const s = typeof input === 'string' ? input : '';
    if (s === '') return [];

    const segments = [];
    let lastIndex = 0;

    // TOKEN is a module-level regex with /g, so its lastIndex has to be reset;
    // otherwise a second call resumes mid-string and drops leading matches.
    TOKEN.lastIndex = 0;

    let match;
    while ((match = TOKEN.exec(s)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ text: s.slice(lastIndex, match.index) });
        }
        segments.push({ route: match[1] });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < s.length) {
        segments.push({ text: s.slice(lastIndex) });
    }
    return segments;
}
