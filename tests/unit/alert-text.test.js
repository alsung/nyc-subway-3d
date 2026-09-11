import { describe, it, expect } from 'vitest';
import { parseAlertText } from '../../src/core/alert-text.js';

// Reassembling every segment must reproduce the input exactly — the property
// that guarantees no alert copy is ever silently dropped on screen.
const reassemble = segs =>
    segs.map(s => (s.route !== undefined ? `[${s.route}]` : s.text)).join('');

describe('parseAlertText', () => {
    it('splits real MTA copy into text and route segments', () => {
        expect(parseAlertText('In Manhattan, [N] skips 28 St - take the [Q] instead'))
            .toEqual([
                { text: 'In Manhattan, ' },
                { route: 'N' },
                { text: ' skips 28 St - take the ' },
                { route: 'Q' },
                { text: ' instead' },
            ]);
    });

    it('handles adjacent tokens with no text between them', () => {
        // "[B][Q] trains are delayed" is the most common shape in the feed.
        expect(parseAlertText('[B][Q] trains are delayed')).toEqual([
            { route: 'B' },
            { route: 'Q' },
            { text: ' trains are delayed' },
        ]);
    });

    it('handles a token at the start and at the end', () => {
        expect(parseAlertText('[7] runs express')).toEqual([
            { route: '7' }, { text: ' runs express' },
        ]);
        expect(parseAlertText('take the [R]')).toEqual([
            { text: 'take the ' }, { route: 'R' },
        ]);
    });

    it('recognizes multi-character route ids', () => {
        expect(parseAlertText('[6X] and [SIR] and [FX]')).toEqual([
            { route: '6X' }, { text: ' and ' },
            { route: 'SIR' }, { text: ' and ' },
            { route: 'FX' },
        ]);
    });

    it('returns a single text segment when there are no tokens', () => {
        expect(parseAlertText('Elevator out of service')).toEqual([
            { text: 'Elevator out of service' },
        ]);
    });

    // Malformed brackets must render as MTA wrote them rather than vanish.
    it('leaves malformed brackets as literal text', () => {
        const cases = [
            'unclosed [N bracket',
            'empty [] brackets',
            'lowercase [n] token',
            'too long [ABCD] token',
            'bracket at end [',
        ];
        for (const input of cases) {
            const segs = parseAlertText(input);
            expect(segs).toEqual([{ text: input }]);
        }
    });

    it('is reversible for every shape', () => {
        const inputs = [
            'In Manhattan, [N] skips 28 St - take the [Q] or [R] instead',
            '[B][Q] trains are delayed',
            'no tokens here',
            'unclosed [N bracket',
            '[7]',
        ];
        for (const input of inputs) {
            expect(reassemble(parseAlertText(input))).toBe(input);
        }
    });

    it('handles empty and non-string input', () => {
        expect(parseAlertText('')).toEqual([]);
        expect(parseAlertText(undefined)).toEqual([]);
        expect(parseAlertText(null)).toEqual([]);
        expect(parseAlertText(42)).toEqual([]);
    });

    // The module-level regex carries /g, so a stale lastIndex would make the
    // second call skip leading matches.
    it('is not affected by previous calls', () => {
        const input = '[N] then [Q]';
        const first = parseAlertText(input);
        const second = parseAlertText(input);
        expect(second).toEqual(first);
        expect(second[0]).toEqual({ route: 'N' });
    });
});
