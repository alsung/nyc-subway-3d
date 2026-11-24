import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// What vercel.json tells Vercel to do with an address (#119). Each of these
// is invisible until production: a catch-all brought back answers every typo
// with the map and a 200, and a lost account rewrite breaks the links in
// every verification and password-reset email.
const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));

describe('vercel.json', () => {
    it('sends no address to the app that has no page, so it gets the 404 page', () => {
        for (const { source } of config.rewrites ?? []) {
            expect(source, source).not.toMatch(/[(*:]/);
        }
    });

    it('serves the app for the two account pages the emails link to', () => {
        expect(config.rewrites).toEqual([
            { source: '/verify', destination: '/index.html' },
            { source: '/reset-password', destination: '/index.html' },
        ]);
    });

    it('keeps the account pages out of search results', () => {
        const noindex = config.headers.find(h => h.headers.some(x => x.key === 'X-Robots-Tag'));
        expect(noindex).toEqual({ source: '/(verify|reset-password)', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] });
    });

    it('gives each page one address, without a trailing slash', () => {
        expect(config.trailingSlash).toBe(false);
    });

    it('still sends /status to the status page', () => {
        expect(config.redirects).toContainEqual(expect.objectContaining({
            source: '/status{/}?', destination: 'https://stats.uptimerobot.com/rC0xhfYVZZ',
        }));
    });

    it('still sends the security headers with every response, the 404 page included', () => {
        const all = config.headers.find(h => h.source === '/(.*)');
        expect(all.headers.map(h => h.key)).toEqual(['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy']);
    });
});
