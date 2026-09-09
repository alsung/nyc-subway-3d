import { describe, it, expect } from 'vitest';
import { pitchForZoom } from '../../src/ui/camera.js';

// The two ends of the ramp, and the pitch the tilted view settles at.
const FLAT_BELOW = 13;
const FULL_ABOVE = 15.5;
const FULL_PITCH = 56;

describe('pitchForZoom', () => {
    it('is flat at and below the overview threshold', () => {
        expect(pitchForZoom(13)).toBe(0);
        expect(pitchForZoom(12)).toBe(0);
        expect(pitchForZoom(9)).toBe(0);
        expect(pitchForZoom(0)).toBe(0);
    });

    it('is fully tilted at and above the close threshold', () => {
        expect(pitchForZoom(15.5)).toBe(FULL_PITCH);
        expect(pitchForZoom(16)).toBe(FULL_PITCH);
        expect(pitchForZoom(22)).toBe(FULL_PITCH);
    });

    it('never exceeds the tilted preset or goes negative', () => {
        for (let z = 0; z <= 22; z += 0.25) {
            const p = pitchForZoom(z);
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(FULL_PITCH);
        }
    });

    it('increases monotonically across the ramp', () => {
        let prev = -1;
        for (let z = FLAT_BELOW; z <= FULL_ABOVE; z += 0.1) {
            const p = pitchForZoom(z);
            expect(p).toBeGreaterThanOrEqual(prev);
            prev = p;
        }
    });

    // Smoothstep, not linear: the tilt should arrive gently and settle rather
    // than ramping at a constant rate and stopping dead.
    it('eases rather than interpolating linearly', () => {
        const mid = (FLAT_BELOW + FULL_ABOVE) / 2;
        expect(pitchForZoom(mid)).toBeCloseTo(FULL_PITCH / 2, 5);

        const quarter = FLAT_BELOW + (FULL_ABOVE - FLAT_BELOW) * 0.25;
        // Linear would give 25% of full pitch; smoothstep gives noticeably less.
        expect(pitchForZoom(quarter)).toBeLessThan(FULL_PITCH * 0.25);
    });

    it('is continuous at both thresholds', () => {
        expect(pitchForZoom(FLAT_BELOW + 0.001)).toBeCloseTo(0, 2);
        expect(pitchForZoom(FULL_ABOVE - 0.001)).toBeCloseTo(FULL_PITCH, 1);
    });

    it('treats a missing or non-finite zoom as overview', () => {
        expect(pitchForZoom(undefined)).toBe(0);
        expect(pitchForZoom(NaN)).toBe(0);
        expect(pitchForZoom(-5)).toBe(0);
    });
});
