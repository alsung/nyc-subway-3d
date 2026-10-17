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

export function signOut() {
    accessToken = null;
    refreshToken = null;
    currentUser = null;
    writePref('refreshToken', null);
    notify();
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

export async function refreshTokens() {
    if (!refreshToken) {
        signOut();
        return false;
    }
    try {
        const res = await fetch(`${API_BASE}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
            signOut();
            return false;
        }
        const data = await res.json();
        signIn(data.accessToken, data.refreshToken, data.user);
        return true;
    } catch {
        signOut();
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
    signOut();
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
    signOut();
}

export async function tryRestoreSession() {
    if (!refreshToken) return;
    await refreshTokens();
}
