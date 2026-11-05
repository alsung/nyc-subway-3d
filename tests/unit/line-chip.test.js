import { describe, it, expect } from 'vitest';
import { lineName } from '../../src/ui/line-chip.js';

// These rows' names, copied from routes.txt. public/gtfs is downloaded by
// `npm run gtfs` and is not in CI.
const routeMap = {
    G: { shortName: 'G', name: 'Brooklyn-Queens Crosstown' },
    SI: { shortName: 'SIR', name: 'Staten Island Railway' },
    GS: { shortName: 'S', name: '42 St Shuttle' },
    FS: { shortName: 'S', name: 'Franklin Avenue Shuttle' },
    H: { shortName: 'S', name: 'Rockaway Park Shuttle' },
};

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
