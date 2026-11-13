import { describe, it, expect, vi } from 'vitest';
import { flyToStation, fitPadding } from '../../src/ui/camera.js';

// The camera is flat and has no pitch curve any more. What is left worth pinning
// is that it stays that way: pitch used to travel with every flyTo, and
// reintroducing it here is the easiest way for tilt to creep back without anyone
// deciding to bring it back.
describe('flyToStation', () => {
    const station = { lat: 40.7549, lng: -73.9876 };

    it('centers on the station at the requested zoom', () => {
        const map = { flyTo: vi.fn() };
        flyToStation(map, station, 15);

        expect(map.flyTo).toHaveBeenCalledOnce();
        const [args] = map.flyTo.mock.calls[0];
        expect(args.center).toEqual([-73.9876, 40.7549]);
        expect(args.zoom).toBe(15);
    });

    it('never asks for a pitch', () => {
        const map = { flyTo: vi.fn() };
        flyToStation(map, station);

        const [args] = map.flyTo.mock.calls[0];
        expect(args).not.toHaveProperty('pitch');
        expect(args).not.toHaveProperty('bearing');
    });
});

// The rectangles are the ones measured in the browser on master, 2026-11-09,
// with Queensboro Plaza → Metropolitan Av open in the trip panel.
describe('fitPadding', () => {
    const desktop = { width: 1400, height: 900 };
    const phone = { width: 390, height: 844 };
    const sidePanel = { left: 20, top: 68, right: 400, bottom: 514 };
    const sheet = { left: 0, top: 386, right: 390, bottom: 844 };
    // The search bar ends at 58 on desktop; the controls end at 118 on a phone,
    // where they drop to a row beneath the search field.
    const DESKTOP_TOP = 58;
    const PHONE_TOP = 118;
    const mapLeft = (view, pad) => ({
        width: view.width - pad.left - pad.right,
        height: view.height - pad.top - pad.bottom,
    });

    it('keeps the desktop framing it had before: 420 px on the left for the side panel', () => {
        expect(fitPadding(desktop, sidePanel, DESKTOP_TOP)).toEqual({ top: 80, right: 80, bottom: 80, left: 420 });
    });

    it('fits above a bottom sheet and below the controls on a phone', () => {
        const pad = fitPadding(phone, sheet, PHONE_TOP);

        expect(pad).toEqual({ top: 138, right: 20, bottom: 478, left: 20 });
        expect(mapLeft(phone, pad)).toEqual({ width: 350, height: 228 });
    });

    it('still leaves 120 px of map when the sheet is at its full 70% of the screen', () => {
        const tall = { ...sheet, top: 844 - 591 };
        const pad = fitPadding(phone, tall, PHONE_TOP);

        expect(mapLeft(phone, pad).height).toBeGreaterThanOrEqual(120);
        // Both sides give way, rather than the fit running under the controls
        // alone.
        expect(pad.top).toBeLessThan(138);
        expect(pad.bottom).toBeLessThan(611);
        expect(pad.bottom).toBeGreaterThan(500);
    });

    it('pads every side by 80 with no panel open', () => {
        expect(fitPadding(desktop, null, DESKTOP_TOP)).toEqual({ top: 80, right: 80, bottom: 80, left: 80 });
    });

    it('never returns negative padding, even on a map smaller than the minimum', () => {
        const pad = fitPadding({ width: 100, height: 100 }, { left: 0, top: 40, right: 100, bottom: 100 }, 30);
        expect(Object.values(pad).every(v => v >= 0)).toBe(true);
    });
});
