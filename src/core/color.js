// src/core/color.js
// Color utilities shared by the renderer and the UI.
// Pure functions - no DOM, no side effects.

/**
 * Return '#000' or '#fff', whichever has better contrast against the given
 * background color. Uses the WCAG perceived-luminance formula.
 * 
 * @param {string} hex e.g., '#EE352E' or 'EE352E'
 * @returns {'#000' | '#fff'}
 */
export function contrastColor(hex) {
    const clean = hex.replace(/^#/, '');
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? '#000' : '#fff';
}

/**
 * Parse a 6-char hex string into RGB components (0-255 each).
 * 
 * @param {string} hex e.g., '#EE352E' or 'EE352E'
 * @returns {{r: number, g: number, b: number}}
 */
export function hexToRGB(hex) {
    const clean = hex.replace(/^#/, '');
    return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16),
    };
}