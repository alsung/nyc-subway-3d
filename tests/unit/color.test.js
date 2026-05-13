import { describe, it, expect } from 'vitest';
import { contrastColor, hexToRGB } from '../../src/core/color.js';

describe('contrastColor', () => {
    it('returns #000 for bright yellow (N/Q/R/W line)', () => {
        expect(contrastColor('#FCCC0A')).toBe('#000');
    })

    it('returns #fff for dark blue (A/C/E line)', () => {
        expect(contrastColor('#2850AD')).toBe('#fff')
    })

    it('returns #fff for red (1/2/3 line)', () => {
        expect(contrastColor('#EE352E')).toBe('#fff')
    })

    it('returns #fff for dark green (4/5/6 line)', () => {
        expect(contrastColor('#00933C')).toBe('#fff')
    })

    it('returns #000 for light gray (L line)', () => {
        expect(contrastColor('#A7A9AC')).toBe('#000')
    })

    it('returns #fff for black', () => {
        expect(contrastColor('#000000')).toBe('#fff')
    })

    it('works without a leading # character', () => {
        expect(contrastColor('FCCC0A')).toBe('#000');
        expect(contrastColor('2850AD')).toBe('#fff')
    })
})

describe('hexToRGB', () => {
    it('parses white as { r:255, g:255, b:255 }', () => {
        expect(hexToRGB('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
    })

    it('parses black as { r:0, g:0, b:0 }', () => {
        expect(hexToRGB('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    })

    it('parses 1-train red correctly', () => {
        const { r, g, b } = hexToRGB('#EE352E');
        expect(r).toBe(0xEE);
        expect(g).toBe(0x35);
        expect(b).toBe(0x2E);
    })

    it('works without a leading # character', () => {
        expect(hexToRGB('FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
        expect(hexToRGB('000000')).toEqual({ r: 0, g: 0, b: 0 });
        expect(hexToRGB('EE352E')).toEqual({ r: 0xEE, g: 0x35, b: 0x2E });
    })
})