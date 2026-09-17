import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readPref, writePref } from '../../src/core/prefs.js';

const withStorage = (impl) => {
    globalThis.window = { localStorage: impl };
};

describe('prefs', () => {
    afterEach(() => { delete globalThis.window; });

    it('round-trips a value', () => {
        const store = new Map();
        withStorage({
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, v),
        });

        writePref('trains', false);
        expect(readPref('trains', true)).toBe(false);
        // Namespaced, so it cannot collide with anything else on the origin.
        expect([...store.keys()]).toEqual(['localexpress:trains']);
    });

    it('returns the fallback for a key never written', () => {
        withStorage({ getItem: () => null, setItem: () => {} });
        expect(readPref('trains', true)).toBe(true);
    });

    it('returns the fallback when storage throws on read', () => {
        // Safari in private browsing, and any browser with site data blocked.
        withStorage({ getItem: () => { throw new Error('denied'); }, setItem: () => {} });
        expect(readPref('trains', true)).toBe(true);
    });

    it('does not throw when storage throws on write', () => {
        withStorage({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
        expect(() => writePref('trains', false)).not.toThrow();
    });

    it('survives storage being absent entirely', () => {
        withStorage(undefined);
        expect(readPref('trains', true)).toBe(true);
        expect(() => writePref('trains', false)).not.toThrow();
    });

    it('returns the fallback rather than throwing on corrupt JSON', () => {
        withStorage({ getItem: () => '{not json', setItem: () => {} });
        expect(readPref('trains', true)).toBe(true);
    });
});
