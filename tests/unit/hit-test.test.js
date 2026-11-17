import { describe, it, expect } from 'vitest';
import { nearestWithin, targetSize, TOUCH_TARGET_PX, POINTER_TARGET_PX } from '../../src/scene/hit-test.js';

// Features placed directly in screen px, so the projection is the identity.
const dot = (id, x, y, lines = '') => ({ id, geometry: { coordinates: [x, y] }, properties: { lines } });
const project = ([x, y]) => ({ x, y });
const tap = { x: 100, y: 100 };

describe('targetSize', () => {
    it('gives a finger the 44 px touch target and a mouse or pen 24 px', () => {
        expect(TOUCH_TARGET_PX).toBe(44);
        expect(POINTER_TARGET_PX).toBe(24);
        expect(targetSize('touch', false)).toBe(44);
        expect(targetSize('mouse', true)).toBe(24);
        expect(targetSize('pen', true)).toBe(24);
    });

    it('falls back to the primary pointer when the event does not say', () => {
        expect(targetSize(undefined, true)).toBe(44);
        expect(targetSize('', false)).toBe(24);
    });
});

describe('nearestWithin', () => {
    it('picks the nearer of two dots', () => {
        const hits = [dot('far', 112, 100), dot('near', 95, 104)];
        expect(nearestWithin(hits, tap, project, 22)?.id).toBe('near');
    });

    it('ignores dots outside the radius, and returns null with nothing in range', () => {
        expect(nearestWithin([dot('a', 123, 100)], tap, project, 22)).toBeNull();
        expect(nearestWithin([dot('a', 122, 100)], tap, project, 22)?.id).toBe('a');
        expect(nearestWithin([], tap, project, 22)).toBeNull();
        expect(nearestWithin(undefined, tap, project, 22)).toBeNull();
    });

    it('lets a preferred dot beat a nearer one that is not', () => {
        const lit = (f) => f.properties.lines.includes('|A|');
        const hits = [dot('dimmed', 102, 100, '|F|'), dot('stop', 115, 100, '|A|')];
        expect(nearestWithin(hits, tap, project, 22, lit)?.id).toBe('stop');
    });

    it('still picks the nearer of two preferred dots', () => {
        const lit = () => true;
        const hits = [dot('far', 115, 100), dot('near', 105, 100)];
        expect(nearestWithin(hits, tap, project, 22, lit)?.id).toBe('near');
    });

    it('does not let a preferred dot out of range win', () => {
        const lit = (f) => f.id === 'stop';
        const hits = [dot('dimmed', 102, 100), dot('stop', 130, 100)];
        expect(nearestWithin(hits, tap, project, 22, lit)?.id).toBe('dimmed');
    });
});
