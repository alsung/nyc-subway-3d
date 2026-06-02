import { describe, it, expect } from 'vitest';
import { geoToXZ, xzToGeo, haversineKm, downsample, MAP_CENTER } from '../../src/core/geo.js';

describe('geoToXZ', () => {
    it('projects the map center to (0, 0)', () => {
        // call geoToXZ with MAP_CENTER.lat and MAP_CENTER.lng
        // expect x to be close to 0
        // expect z to be close to 0
        const { x, z } = geoToXZ(MAP_CENTER.lat, MAP_CENTER.lng);
        expect(x).toBeCloseTo(0);
        expect(z).toBeCloseTo(0);
    })

    it('east of center produces positive x', () => {
        const { x } = geoToXZ(MAP_CENTER.lat, MAP_CENTER.lng + 0.1);
        expect(x).toBeGreaterThan(0);
    })

    it('north of center produces negative z', () => {
        const { z } = geoToXZ(MAP_CENTER.lat + 0.1, MAP_CENTER.lng);
        expect(z).toBeLessThan(0);
    })

    it('applies cosine correction — 1° longitude produces smaller x than 1° latitude produces z', () => {
        const { x } = geoToXZ(MAP_CENTER.lat, MAP_CENTER.lng + 1);
        const { z } = geoToXZ(MAP_CENTER.lat + 1, MAP_CENTER.lng);
        expect(Math.abs(x)).toBeLessThan(Math.abs(z));
    })

    it('Times Square is west and north of center', () => {
        const { x, z } = geoToXZ(40.7558, -73.9879);
        expect(x).toBeLessThan(0);
        expect(z).toBeLessThan(0);
    })

    it('returns finite numbers', () => {
        const { x, z } = geoToXZ(40.7558, -73.9879);
        expect(isFinite(x)).toBe(true);
        expect(isFinite(z)).toBe(true);
    })
})

describe('xzToGeo', () => {
    it('round-trips the map center', () => {
        const { x, z } = geoToXZ(MAP_CENTER.lat, MAP_CENTER.lng);
        const { lat, lng } = xzToGeo(x, z);
        expect(lat).toBeCloseTo(MAP_CENTER.lat, 5);
        expect(lng).toBeCloseTo(MAP_CENTER.lng, 5);
    })

    it('round-trips Times Square', () => {
    const lat = 40.7558, lng = -73.9879;
    const { x, z } = geoToXZ(lat, lng);
    const back = xzToGeo(x, z);
    expect(back.lat).toBeCloseTo(lat, 5);
    expect(back.lng).toBeCloseTo(lng, 5);
  })

  it('round-trips a southern Brooklyn point', () => {
    const lat = 40.5775, lng = -73.9812;
    const { x, z } = geoToXZ(lat, lng);
    const back = xzToGeo(x, z);
    expect(back.lat).toBeCloseTo(lat, 5);
    expect(back.lng).toBeCloseTo(lng, 5);
  })
})

describe('haversineKm', () => {
  it('returns 0 for the same point', () => {
    const pt = { lat: 40.730, lng: -73.960 };
    expect(haversineKm(pt, pt)).toBeCloseTo(0, 5);
  })

  it('is symmetric — distance(A→B) equals distance(B→A)', () => {
    const a = { lat: 40.730, lng: -73.960 };
    const b = { lat: 40.780, lng: -73.980 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 8);
  })

  it('measures roughly 1km between points ~0.009° of latitude apart', () => {
    const a = { lat: 40.730, lng: -73.960 };
    const b = { lat: 40.739, lng: -73.960 };
    expect(haversineKm(a, b)).toBeCloseTo(1.0, 0);
  })

  it('Times Square to Grand Central is between 0.5 and 1.5 km', () => {
    const a = { lat: 40.7558, lng: -73.9879 };
    const b = { lat: 40.7523, lng: -73.9764 };
    const d = haversineKm(a, b);
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(1.5);
  })
})

describe('downsample', () => {
  it('returns the array unchanged when length is under maxPoints', () => {
    const pts = Array.from({ length: 50 }, (_, i) => i);
    expect(downsample(pts, 300)).toEqual(pts);
  })

  it('returns at most maxPoints + 1 items', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    expect(downsample(pts, 300).length).toBeLessThanOrEqual(301);
  })

  it('always includes the first point', () => {
    const pts = Array.from({ length: 500 }, (_, i) => i);
    expect(downsample(pts, 100)[0]).toBe(0);
  })

  it('always includes the last point', () => {
    const pts = Array.from({ length: 500 }, (_, i) => i);
    const result = downsample(pts, 100);
    expect(result[result.length - 1]).toBe(499);
  })

  it('returns the array unchanged when length equals maxPoints', () => {
    const pts = Array.from({ length: 300 }, (_, i) => i);
    expect(downsample(pts, 300)).toEqual(pts);
  })

  it('handles a 2-element array', () => {
    expect(downsample([1, 2], 300)).toEqual([1, 2]);
  })
})