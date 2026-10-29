import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prefs.js before importing auth — auth reads refreshToken at module load.
vi.mock('../../src/core/prefs.js', () => ({
    readPref: vi.fn(() => null),
    writePref: vi.fn(),
}));

const { getUser, onAuthChange, signIn, signOut, parseJWT, authFetch, tryRestoreSession, refreshTokens } =
    await import('../../src/core/auth.js');
const { readPref, writePref } = await import('../../src/core/prefs.js');

beforeEach(() => {
    vi.restoreAllMocks();
    readPref.mockImplementation(() => null);
    // signOut() sends a logout request, so every test starts with a fetch
    // stub that answers it; tests that care about fetch replace it.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }));
    signOut();
});

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const isRefresh = (url) => String(url).endsWith('/api/auth/refresh');
const isLogout = (url) => String(url).endsWith('/api/auth/logout');
const newSession = { accessToken: 'new-access', refreshToken: 'new-refresh', user: { id: '1' } };

describe('parseJWT', () => {
    it('decodes a standard JWT payload', () => {
        const payload = { sub: 'user-123', email: 'test@example.com', exp: 9999999999 };
        const encoded = btoa(JSON.stringify(payload)).replace(/=/g, '');
        const token = `header.${encoded}.signature`;
        expect(parseJWT(token)).toMatchObject(payload);
    });

    it('handles base64url characters', () => {
        const payload = { sub: 'abc+/=def' };
        const raw = btoa(JSON.stringify(payload));
        const urlSafe = raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        const token = `h.${urlSafe}.s`;
        expect(parseJWT(token)).toMatchObject(payload);
    });

    it('returns null for garbage', () => {
        expect(parseJWT('')).toBeNull();
        expect(parseJWT('not.a.jwt')).toBeNull();
        expect(parseJWT(null)).toBeNull();
        expect(parseJWT(undefined)).toBeNull();
    });
});

describe('signIn / signOut / getUser', () => {
    it('getUser returns null before sign-in', () => {
        expect(getUser()).toBeNull();
    });

    it('signIn sets the current user', () => {
        const user = { id: '1', email: 'a@b.c', displayName: 'A', avatarUrl: '', tier: 'free' };
        signIn('access-tok', 'refresh-tok', user);
        expect(getUser()).toEqual(user);
    });

    it('signOut clears the current user', () => {
        signIn('a', 'r', { id: '1' });
        signOut();
        expect(getUser()).toBeNull();
    });

    it('signIn persists the refresh token', () => {
        signIn('a', 'my-refresh', { id: '1' });
        expect(writePref).toHaveBeenCalledWith('refreshToken', 'my-refresh');
    });

    it('signOut clears the persisted refresh token', () => {
        signIn('a', 'r', { id: '1' });
        signOut();
        expect(writePref).toHaveBeenCalledWith('refreshToken', null);
    });
});

describe('onAuthChange', () => {
    it('notifies listeners on signIn', () => {
        const cb = vi.fn();
        onAuthChange(cb);
        const user = { id: '1' };
        signIn('a', 'r', user);
        expect(cb).toHaveBeenCalledWith(user);
    });

    it('notifies listeners on signOut', () => {
        const cb = vi.fn();
        signIn('a', 'r', { id: '1' });
        onAuthChange(cb);
        signOut();
        expect(cb).toHaveBeenCalledWith(null);
    });

    it('returns an unsubscribe function', () => {
        const cb = vi.fn();
        const unsub = onAuthChange(cb);
        unsub();
        signIn('a', 'r', { id: '1' });
        expect(cb).not.toHaveBeenCalled();
    });
});

describe('authFetch', () => {
    it('adds Authorization header when signed in', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
        vi.stubGlobal('fetch', mockFetch);

        signIn('my-token', 'r', { id: '1' });
        await authFetch('https://example.com/api');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://example.com/api',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer my-token' }),
            }),
        );
    });

    it('omits Authorization header when signed out', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
        vi.stubGlobal('fetch', mockFetch);

        await authFetch('https://example.com/api');

        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers.Authorization).toBeUndefined();
    });

    it('preserves caller-supplied headers', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true });
        vi.stubGlobal('fetch', mockFetch);

        signIn('tok', 'r', { id: '1' });
        await authFetch('https://example.com/api', {
            headers: { 'Content-Type': 'application/json' },
        });

        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['Authorization']).toBe('Bearer tok');
    });
});

describe('tryRestoreSession', () => {
    it('is a no-op with no stored refresh token', async () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        await tryRestoreSession();

        expect(mockFetch).not.toHaveBeenCalled();
        expect(getUser()).toBeNull();
    });
});

describe('refresh', () => {
    it('shares one refresh between concurrent 401s', async () => {
        const mockFetch = vi.fn(async (url, opts) => {
            if (isRefresh(url)) return json(200, newSession);
            return opts.headers.Authorization === 'Bearer new-access' ? json(200, {}) : json(401, {});
        });
        vi.stubGlobal('fetch', mockFetch);
        signIn('old-access', 'old-refresh', { id: '1' });

        const [a, b] = await Promise.all([authFetch('https://example.com/a'), authFetch('https://example.com/b')]);

        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(mockFetch.mock.calls.filter(([url]) => isRefresh(url))).toHaveLength(1);
    });

    it('keeps the session when the refresh request fails to send', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
        signIn('a', 'r', { id: '1' });

        expect(await refreshTokens()).toBe(false);
        expect(getUser()).toEqual({ id: '1' });
    });

    it('keeps the session when the server errors', async () => {
        for (const status of [500, 429]) {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(status, {})));
            signIn('a', 'r', { id: '1' });

            expect(await refreshTokens()).toBe(false);
            expect(getUser()).toEqual({ id: '1' });
        }
    });

    it('signs out when the server rejects the token, without a logout call', async () => {
        const mockFetch = vi.fn().mockResolvedValue(json(401, {}));
        vi.stubGlobal('fetch', mockFetch);
        signIn('a', 'r', { id: '1' });

        expect(await refreshTokens()).toBe(false);
        expect(getUser()).toBeNull();
        expect(mockFetch.mock.calls.filter(([url]) => isLogout(url))).toHaveLength(0);
    });

    it('uses the token in storage, which another tab may have rotated', async () => {
        const mockFetch = vi.fn().mockResolvedValue(json(200, newSession));
        vi.stubGlobal('fetch', mockFetch);
        signIn('a', 'this-tab-token', { id: '1' });
        readPref.mockImplementation((key) => (key === 'refreshToken' ? 'other-tab-token' : null));

        await refreshTokens();

        expect(JSON.parse(mockFetch.mock.calls[0][1].body).refreshToken).toBe('other-tab-token');
    });
});

describe('signOut', () => {
    it('revokes the refresh token on the server', () => {
        const mockFetch = vi.fn().mockResolvedValue(json(200, {}));
        vi.stubGlobal('fetch', mockFetch);
        signIn('a', 'r-to-revoke', { id: '1' });

        signOut();

        const [url, opts] = mockFetch.mock.calls[0];
        expect(isLogout(url)).toBe(true);
        expect(JSON.parse(opts.body)).toEqual({ refreshToken: 'r-to-revoke' });
        expect(getUser()).toBeNull();
    });

    it('sends nothing when already signed out', () => {
        const mockFetch = vi.fn();
        vi.stubGlobal('fetch', mockFetch);

        signOut();

        expect(mockFetch).not.toHaveBeenCalled();
    });
});
