import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lineName } from '../../src/ui/line-chip.js';
import { parseRoutes } from '../../src/core/gtfs-parser.js';

const routeMap = parseRoutes(readFileSync(
    fileURLToPath(new URL('../../public/gtfs/routes.txt', import.meta.url)), 'utf8'));

describe('lineName', () => {
    it('names a line by its short name', () => {
        expect(lineName('G', routeMap)).toBe('G line');
        expect(lineName('SI', routeMap)).toBe('SIR line');
    });

    it('names each shuttle by its long name, since all three are signed "S"', () => {
        const names = ['GS', 'FS', 'H'].map(id => lineName(id, routeMap));
        expect(names).toEqual(['42 St Shuttle', 'Franklin Avenue Shuttle', 'Rockaway Park Shuttle']);
    });

    it('falls back to the route id for a route the map does not know', () => {
        expect(lineName('Q9', routeMap)).toBe('Q9 line');
    });
});
