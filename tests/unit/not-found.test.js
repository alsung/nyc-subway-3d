import { describe, it, expect, vi } from 'vitest';
import { pageFor, forward } from '../../src/not-found.js';
import { parseStationPath } from '../../src/core/slugs.js';

const pages = {
    stations: { 611: '/station/611-times-sq-42-st', 636: '/station/636-jay-st-metrotech' },
    lines: ['/line/g', '/line/a', '/line/s-42-st', '/line/sir'],
};

describe('pageFor', () => {
    it.each([
        ['/station/611', '/station/611-times-sq-42-st'],
        ['/station/611/', '/station/611-times-sq-42-st'],
        ['/station/611-times-sq', '/station/611-times-sq-42-st'],
        ['/station/611-42-st-times-square', '/station/611-times-sq-42-st'],
        ['/STATION/611-Times-Sq-42-St', '/station/611-times-sq-42-st'],
        ['/station/636-jay-st', '/station/636-jay-st-metrotech'],
    ])('sends the station link %s on to %s', (path, target) => {
        expect(pageFor(path, pages)).toBe(target);
    });

    it.each([
        ['/line/G', '/line/g'],
        ['/LINE/A', '/line/a'],
        ['/line/S-42-St', '/line/s-42-st'],
        ['/line/SIR/', '/line/sir'],
    ])('sends the line link %s on to %s', (path, target) => {
        expect(pageFor(path, pages)).toBe(target);
    });

    it.each([
        '/station/99999',
        '/station/99999-nowhere',
        '/station/constructor',
        '/station/611-times sq',
        '/station/611/extra',
        '/station/',
        '/line/zz',
        '/line/g/stops',
        '/nonsense',
        '/',
        '',
    ])('leaves %j on the 404 page', (path) => {
        expect(pageFor(path, pages)).toBeNull();
    });

    it('never sends a page to itself, so a page missing from a deploy cannot loop', () => {
        expect(pageFor('/station/611-times-sq-42-st', pages)).toBeNull();
        expect(pageFor('/line/g', pages)).toBeNull();
    });

    it('finds nothing without the list of pages', () => {
        expect(pageFor('/station/611')).toBeNull();
        expect(pageFor('/station/611', { stations: { 611: 42 } })).toBeNull();
        expect(pageFor('/line/G', {})).toBeNull();
    });

    it('reads a station path the way the app does', () => {
        // The app's parser decides which station links have ever opened a
        // station; this has to forward exactly those.
        const ids = { stations: { 611: '/station/611-x', 1: '/station/1-x', 0: '/station/0-x' } };
        for (const path of [
            '/station/611', '/station/611/', '/station/611-old-name', '/Station/611-Old-Name', '/station/1',
            '/station/0', '/station/611-a_b', '/station/611-%20', '/station/-611', '/station/611x', '/station/611//',
            '/x/station/611', '/station/611-x/y',
        ]) {
            const id = parseStationPath(path);
            expect(pageFor(path, ids), path).toBe(id && ids.stations[id] !== path ? ids.stations[id] : null);
        }
    });
});

describe('forward', () => {
    const page = (json) => ({ getElementById: (id) => (id === 'page-paths' && json !== undefined ? { textContent: json } : null) });
    const at = (pathname, search = '', hash = '') => ({ pathname, search, hash, replace: vi.fn() });

    it('replaces the address with the page, keeping the query and fragment', () => {
        const loc = at('/station/611', '?utm_source=x', '#arrivals');
        forward(page(JSON.stringify(pages)), loc);
        expect(loc.replace).toHaveBeenCalledWith('/station/611-times-sq-42-st?utm_source=x#arrivals');
    });

    it('stays on the 404 page for an address that names nothing', () => {
        const loc = at('/nonsense');
        forward(page(JSON.stringify(pages)), loc);
        expect(loc.replace).not.toHaveBeenCalled();
    });

    it('stays on the 404 page when the list is missing or unreadable', () => {
        for (const doc of [page(undefined), page(''), page('{"stations":'), page('null')]) {
            const loc = at('/station/611');
            expect(() => forward(doc, loc)).not.toThrow();
            expect(loc.replace).not.toHaveBeenCalled();
        }
    });
});
