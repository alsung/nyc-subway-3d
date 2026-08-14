import { describe, it, expect } from 'vitest';
import {
    trunkDisplay,
    systemTone,
    alertsForTrunk,
    dedupeBulletRoutes,
    TRUNK_ORDER,
} from '../../src/core/alert-status.js';

describe('trunkDisplay', () => {
    it('reports no alerts and is not interactive', () => {
        expect(trunkDisplay({ status: 'none', count: 0 }))
            .toEqual({ text: 'No alerts', tone: 'none', interactive: false });
    });

    it('names the alert type when exactly one is active', () => {
        expect(trunkDisplay({ status: 'incident', count: 1, label: 'Delays' }))
            .toEqual({ text: 'Delays', tone: 'incident', interactive: true });
    });

    it('counts when several are active', () => {
        expect(trunkDisplay({ status: 'incident', count: 3, label: 'Delays' }))
            .toEqual({ text: '3 alerts', tone: 'incident', interactive: true });
    });

    it('falls back to a count when the label is missing at count 1', () => {
        // Happens when MTA's Mercury extension could not be read.
        expect(trunkDisplay({ status: 'planned', count: 1 }).text).toBe('1 alert');
        expect(trunkDisplay({ status: 'planned', count: 1, label: '   ' }).text).toBe('1 alert');
    });

    it('carries the planned tone through', () => {
        expect(trunkDisplay({ status: 'planned', count: 1, label: 'Planned - Reroute' }))
            .toEqual({ text: 'Planned - Reroute', tone: 'planned', interactive: true });
    });

    it('treats a negative or absent count as none', () => {
        expect(trunkDisplay({ status: 'incident', count: -2 }).text).toBe('No alerts');
        expect(trunkDisplay({}).text).toBe('No alerts');
        expect(trunkDisplay(undefined).text).toBe('No alerts');
    });
});

describe('systemTone', () => {
    it('is none when nothing is active', () => {
        expect(systemTone([
            { status: 'none', count: 0 },
            { status: 'none', count: 0 },
        ])).toBe('none');
    });

    it('is planned when only planned work is active', () => {
        expect(systemTone([
            { status: 'none', count: 0 },
            { status: 'planned', count: 2 },
        ])).toBe('planned');
    });

    it('lets an incident anywhere outrank planned work', () => {
        expect(systemTone([
            { status: 'planned', count: 5 },
            { status: 'incident', count: 1 },
        ])).toBe('incident');
    });

    it('ignores a status with a zero count', () => {
        // The API reports status alongside count; a zero count means the trunk
        // is clear regardless of what the status field says.
        expect(systemTone([{ status: 'incident', count: 0 }])).toBe('none');
    });

    it('handles empty and missing input', () => {
        expect(systemTone([])).toBe('none');
        expect(systemTone(undefined)).toBe('none');
    });
});

describe('alertsForTrunk', () => {
    const alerts = [
        { id: 'a', surfaced: true, routeIds: ['B', 'Q'] },
        { id: 'b', surfaced: true, routeIds: ['7'] },
        { id: 'c', surfaced: false, routeIds: ['B'] },
        { id: 'd', surfaced: true, routeIds: [] },
    ];

    it('matches on any shared route', () => {
        expect(alertsForTrunk(alerts, ['B', 'D', 'F', 'M']).map(a => a.id)).toEqual(['a']);
    });

    it('matches the same alert from a different trunk', () => {
        // One alert naming B and Q belongs to both BDFM and NQRW.
        expect(alertsForTrunk(alerts, ['N', 'Q', 'R', 'W']).map(a => a.id)).toEqual(['a']);
    });

    it('excludes unsurfaced alerts', () => {
        expect(alertsForTrunk(alerts, ['B']).map(a => a.id)).toEqual(['a']);
    });

    it('excludes alerts with no routes', () => {
        expect(alertsForTrunk(alerts, ['B', 'Q', '7']).map(a => a.id)).toEqual(['a', 'b']);
    });

    it('handles empty and missing input', () => {
        expect(alertsForTrunk([], ['B'])).toEqual([]);
        expect(alertsForTrunk(undefined, ['B'])).toEqual([]);
        expect(alertsForTrunk(alerts, undefined)).toEqual([]);
    });
});

describe('TRUNK_ORDER', () => {
    it('covers all eleven trunks without duplicates', () => {
        expect(TRUNK_ORDER).toHaveLength(11);
        expect(new Set(TRUNK_ORDER).size).toBe(11);
    });
});

describe('dedupeBulletRoutes', () => {
    const routeMap = {
        GS: { shortName: 'S' }, FS: { shortName: 'S' }, H: { shortName: 'S' },
        N: { shortName: 'N' }, Q: { shortName: 'Q' },
    };

    it('collapses the three shuttles to one S bullet', () => {
        // GTFS gives GS, FS and H all route_short_name "S", so rendering each
        // would put three indistinguishable bullets on the shuttle row.
        expect(dedupeBulletRoutes(['GS', 'FS', 'H'], routeMap)).toEqual(['GS']);
    });

    it('keeps distinct routes', () => {
        expect(dedupeBulletRoutes(['N', 'Q'], routeMap)).toEqual(['N', 'Q']);
    });

    it('falls back to the route id when it is not in routeMap', () => {
        expect(dedupeBulletRoutes(['ZZ', 'ZZ', 'N'], routeMap)).toEqual(['ZZ', 'N']);
    });

    it('handles empty and missing input', () => {
        expect(dedupeBulletRoutes([], routeMap)).toEqual([]);
        expect(dedupeBulletRoutes(undefined, routeMap)).toEqual([]);
        expect(dedupeBulletRoutes(['N'], undefined)).toEqual(['N']);
    });
});
