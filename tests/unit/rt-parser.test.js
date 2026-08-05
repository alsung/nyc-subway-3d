import { describe, it, expect } from 'vitest';
import { normalizeStopId, VEHICLE_STATUS } from '../../src/core/rt-parser.js';

// ── normalizeStopId ───────────────────────────────────────────────────────────

describe('normalizeStopId', () => {
    it('strips N suffix', () => {
        expect(normalizeStopId('127N')).toBe('127');
    });

    it('strips S suffix', () => {
        expect(normalizeStopId('127S')).toBe('127');
    });

    it('leaves non-directional IDs unchanged', () => {
        expect(normalizeStopId('A27')).toBe('A27');
    });

    it('leaves IDs ending in letters other than N or S unchanged', () => {
        expect(normalizeStopId('G22')).toBe('G22');
    });

    it('handles empty string', () => {
        expect(normalizeStopId('')).toBe('');
    });
});

// ── VEHICLE_STATUS ────────────────────────────────────────────────────────────

describe('VEHICLE_STATUS', () => {
    it('matches the GTFS-RT VehicleStopStatus enum ordering', () => {
        expect(VEHICLE_STATUS.INCOMING_AT).toBe(0);
        expect(VEHICLE_STATUS.STOPPED_AT).toBe(1);
        expect(VEHICLE_STATUS.IN_TRANSIT_TO).toBe(2);
    });
});
