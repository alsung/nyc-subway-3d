import { describe, it, expect, beforeEach } from 'vitest';
import { routeBullet } from '../../src/ui/route-bullet.js';

// A minimal DOM: this module only builds one span and sets a few properties.
beforeEach(() => {
    const classes = () => {
        const set = new Set();
        return {
            add: (...c) => c.forEach(x => set.add(x)),
            contains: (c) => set.has(c),
            toString: () => [...set].join(' '),
        };
    };
    globalThis.document = {
        createElement: () => ({ className: '', textContent: '', style: {}, classList: classes() }),
    };
});

const routeMap = {
    '6':  { shortName: '6',   color: '#009952' },
    '6X': { shortName: '6X',  color: '#009952' },
    '7':  { shortName: '7',   color: '#9A38A1' },
    '7X': { shortName: '7X',  color: '#9A38A1' },
    F:    { shortName: 'F',   color: '#EB6800' },
    FX:   { shortName: 'FX',  color: '#EB6800' },
    SI:   { shortName: 'SIR', color: '#08179C' },
    N:    { shortName: 'N',   color: '#F6BC26' },
};

describe('routeBullet', () => {
    it('renders an ordinary route as a circle carrying its own label', () => {
        const el = routeBullet('6', routeMap);
        expect(el.textContent).toBe('6');
        expect(el.classList.contains('alert-bullet--express')).toBe(false);
        expect(el.classList.contains('alert-bullet--wide')).toBe(false);
    });

    it('renders an express as a diamond carrying its parent line', () => {
        // "7X" appears on no sign in the system, and this bullet shows up in
        // arrivals lists a rider reads to decide which train to wait for.
        for (const [id, label] of [['6X', '6'], ['7X', '7'], ['FX', 'F']]) {
            const el = routeBullet(id, routeMap);
            expect(el.textContent).toBe(label);
            expect(el.classList.contains('alert-bullet--express')).toBe(true);
        }
    });

    it('keeps the express in its parent line\'s color', () => {
        expect(routeBullet('7X', routeMap).style.backgroundColor).toBe('#9A38A1');
    });

    it('still widens a three-character label', () => {
        const el = routeBullet('SI', routeMap);
        expect(el.textContent).toBe('SIR');
        expect(el.classList.contains('alert-bullet--wide')).toBe(true);
        expect(el.classList.contains('alert-bullet--express')).toBe(false);
    });

    it('names an unknown route rather than rendering an empty badge', () => {
        const el = routeBullet('ZZ', routeMap);
        expect(el.textContent).toBe('ZZ');
        expect(el.style.backgroundColor).toBe('#808183');
    });
});
