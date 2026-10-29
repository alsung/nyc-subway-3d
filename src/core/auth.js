import { readPref, writePref } from './prefs.js';

const API_BASE = import.meta.env.PROD
    ? 'https://nyc-subway-api.fly.dev'
    : 'http://localhost:8080';

const REFRESH_MARGIN_MS = 60_000;

let accessToken = null;
let refreshToken = readPref('refreshToken', null);
let currentUser = null;
const listeners = new Set();

function notify() {
    for (const cb of listeners) {
        try { cb(currentUser); } catch { /* listener errors are not our problem */ }
    }
}

export function getUser() {
    return currentUser;
}

export function onAuthChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function signIn(access, refresh, user) {
    accessToken = access;
    refreshToken = refresh;
    currentUser = user;
    writePref('refreshToken', refresh);
    notify();
}

function clearSession() {
    accessToken = null;
    refreshToken = null;
    currentUser = null;
    writePref('refreshToken', null);
    notify();
}

/** Signs out here and revokes the refresh token on the server. */
export function signOut() {
    const token = refreshToken;
    clearSession();
    if (token) {
        // Not awaited: signing out locally shouldn't wait on the network.
        // keepalive lets the request finish if the page is closing.
        fetch(`${API_BASE}/api/auth/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: token }),
            keepalive: true,
        }).catch(() => {});
    }
}

export function parseJWT(token) {
    try {
        const payload = token.split('.')[1];
        const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(padded));
    } catch {
        return null;
    }
}

function tokenExpiresWithin(token, ms) {
    const claims = parseJWT(token);
    if (!claims?.exp) return false;
    return claims.exp * 1000 - Date.now() < ms;
}

let refreshInFlight = null;

/**
 * Trades the refresh token for a new pair. Each token works once, so only one
 * refresh may run at a time: concurrent callers in this tab share one
 * request, and other tabs wait on a Web Lock (the token in storage is shared
 * by every tab). Signs out only when the server rejects the token; offline or
 * a server error keeps the session for the next try.
 */
export function refreshTokens() {
    if (!refreshInFlight) {
        refreshInFlight = withRefreshLock(refreshOnce).finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
}

function withRefreshLock(fn) {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request('local-express-refresh', fn) : fn();
}

async function refreshOnce() {
    // Another tab may have rotated the token while this one waited.
    const token = readPref('refreshToken', null) ?? refreshToken;
    if (!token) {
        clearSession();
        return false;
    }
    try {
        const res = await fetch(`${API_BASE}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: token }),
        });
        if (res.status === 401) {
            // The token is already dead, so there's nothing to revoke.
            clearSession();
            return false;
        }
        if (!res.ok) return false;
        const data = await res.json();
        signIn(data.accessToken, data.refreshToken, data.user);
        return true;
    } catch {
        return false;
    }
}

export async function authFetch(url, opts = {}) {
    if (accessToken && tokenExpiresWithin(accessToken, REFRESH_MARGIN_MS)) {
        await refreshTokens();
    }

    const headers = { ...opts.headers };
    if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
    }

    let res = await fetch(url, { ...opts, headers });

    if (res.status === 401 && refreshToken) {
        const refreshed = await refreshTokens();
        if (refreshed) {
            headers['Authorization'] = `Bearer ${accessToken}`;
            res = await fetch(url, { ...opts, headers });
        }
    }

    return res;
}

export async function updateAccount(displayName) {
    const res = await authFetch(`${API_BASE}/api/auth/account`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update account');
    }
    const user = await res.json();
    currentUser = user;
    notify();
    return user;
}

export async function deleteAccount() {
    const res = await authFetch(`${API_BASE}/api/auth/account`, {
        method: 'DELETE',
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete account');
    }
    // The server already revoked every session for this account.
    clearSession();
}

export async function changePassword(currentPassword, newPassword) {
    const res = await authFetch(`${API_BASE}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to change password');
    }
    // The server already revoked every session for this account.
    clearSession();
}

export async function tryRestoreSession() {
    if (!refreshToken) return;
    const restored = await refreshTokens();
    // Offline at startup keeps the token, so try again once the connection
    // comes back instead of waiting for a reload.
    if (!restored && refreshToken && typeof window !== 'undefined') {
        window.addEventListener('online', () => refreshTokens(), { once: true });
    }
}
