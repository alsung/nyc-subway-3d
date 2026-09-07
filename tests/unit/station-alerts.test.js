import { describe, it, expect } from 'vitest';
import { alertedStationIds, alertsForStation } from '../../src/core/station-alerts.js';

const alert = (over = {}) => ({
    id: 'a1', kind: 'planned', label: 'Planned - Stops Skipped',
    routeIds: [], stopIds: [], surfaced: true, ...over,
});

describe('alertedStationIds', () => {
    it('collects stop ids from surfaced alerts', () => {
        const out = alertedStationIds([
            alert({ stopIds: ['101', '102'] }),
            alert({ stopIds: ['102', '103'] }),
        ]);
        expect([...out].sort()).toEqual(['101', '102', '103']);
    });

    it('ignores alerts that are not surfaced', () => {
        const out = alertedStationIds([
            alert({ stopIds: ['101'], surfaced: false }),
            alert({ stopIds: ['102'] }),
        ]);
        expect([...out]).toEqual(['102']);
    });

    // The live feed's two "Delays" alerts both carried zero stopIds.
    it('yields nothing for route-scoped alerts, including incidents', () => {
        const out = alertedStationIds([
            alert({ kind: 'incident', label: 'Delays', routeIds: ['A', 'C'], stopIds: [] }),
        ]);
        expect(out.size).toBe(0);
    });

    it('handles empty and missing input', () => {
        expect(alertedStationIds([]).size).toBe(0);
        expect(alertedStationIds(undefined).size).toBe(0);
    });
});

describe('alertsForStation', () => {
    it('matches an alert that names the station', () => {
        const a = alert({ id: 'hit', stopIds: ['101'] });
        expect(alertsForStation([a], ['101'], [])).toEqual([a]);
    });

    it('matches any id in a station complex', () => {
        const a = alert({ id: 'hit', stopIds: ['635'] });
        expect(alertsForStation([a], ['631', '635'], [])).toEqual([a]);
    });

    it('matches a route-scoped incident only for routes seen at the station', () => {
        const delays = alert({ id: 'delays', kind: 'incident', routeIds: ['A'], stopIds: [] });
        expect(alertsForStation([delays], ['101'], ['A'])).toEqual([delays]);
        expect(alertsForStation([delays], ['101'], ['L'])).toEqual([]);
    });

    // The live feed's "Sunday Schedule" carries 22 of 29 routes and no stops.
    // Admitting route-scoped planned work would repeat it in every popup.
    it('ignores route-scoped planned work however many routes it names', () => {
        const systemWide = alert({
            id: 'sunday', kind: 'planned', label: 'Sunday Schedule',
            routeIds: ['1', '2', '3', 'A', 'C', 'E', 'L'], stopIds: [],
        });
        expect(alertsForStation([systemWide], ['101'], ['1'])).toEqual([]);
    });

    // Planned work that names this stop is still about this stop.
    it('keeps station-scoped planned work', () => {
        const a = alert({ id: 'skip', kind: 'planned', stopIds: ['101'] });
        expect(alertsForStation([a], ['101'], [])).toEqual([a]);
    });

    it('does not apply a station-scoped alert to a station it omits', () => {
        // Names other stops on a route we serve — it is about those stops.
        const a = alert({ stopIds: ['201', '202'], routeIds: ['A'] });
        expect(alertsForStation([a], ['101'], ['A'])).toEqual([]);
    });

    it('orders station-scoped matches before route-scoped ones', () => {
        const viaRoute = alert({ id: 'route', kind: 'incident', routeIds: ['A'], stopIds: [] });
        const direct = alert({ id: 'stop', stopIds: ['101'] });
        const out = alertsForStation([viaRoute, direct], ['101'], ['A']);
        expect(out.map(a => a.id)).toEqual(['stop', 'route']);
    });

    it('excludes alerts that are not surfaced', () => {
        const a = alert({ stopIds: ['101'], surfaced: false });
        expect(alertsForStation([a], ['101'], [])).toEqual([]);
    });

    it('never lists the same alert twice', () => {
        const both = alert({ id: 'both', stopIds: ['101'], routeIds: ['A'] });
        expect(alertsForStation([both], ['101'], ['A'])).toEqual([both]);
    });

    it('handles empty and missing input', () => {
        expect(alertsForStation([], ['101'], ['A'])).toEqual([]);
        expect(alertsForStation(undefined, undefined, undefined)).toEqual([]);
    });
});
