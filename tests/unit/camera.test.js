import { describe, it, expect, vi } from 'vitest';
import { flyToStation } from '../../src/ui/camera.js';

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
