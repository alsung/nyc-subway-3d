import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/auth.js', () => ({
    authFetch: vi.fn(),
}));

const { loadFeatures, hasFeature, getFeatures } =
    await import('../../src/core/features.js');
const { authFetch } = await import('../../src/core/auth.js');

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('hasFeature', () => {
    it('returns false for an unknown feature before any load', () => {
        expect(hasFeature('nonexistent')).toBe(false);
    });
});

describe('loadFeatures', () => {
    it('treats a failed fetch as empty', async () => {
        authFetch.mockRejectedValue(new Error('network'));
        await loadFeatures();
        expect(hasFeature('trip_planner')).toBe(false);
        expect(getFeatures()).toHaveLength(0);
    });

    it('treats a non-ok response as empty', async () => {
        authFetch.mockResolvedValue({ ok: false });
        await loadFeatures();
        expect(hasFeature('trip_planner')).toBe(false);
    });

    it('populates the cache from the API', async () => {
        authFetch.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                features: [
                    { name: 'trip_planner', requiredTier: 'everyone', accessible: true },
                    { name: 'ai_assistant', requiredTier: 'pro', accessible: false },
                ],
            }),
        });

        await loadFeatures();

        expect(hasFeature('trip_planner')).toBe(true);
        expect(hasFeature('ai_assistant')).toBe(false);
        expect(getFeatures()).toHaveLength(2);
    });
});
