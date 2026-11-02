import { authFetch } from './auth.js';

import { API_BASE } from './config.js';

let cache = [];
const listeners = new Set();

function notify() {
    for (const cb of listeners) {
        try { cb(cache); } catch { /* listener errors are not our problem */ }
    }
}

export function onCommutesChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function getCommutes() {
    return cache;
}

export async function loadCommutes() {
    try {
        const res = await authFetch(`${API_BASE}/api/commutes`);
        if (!res.ok) return;
        const data = await res.json();
        cache = data.commutes ?? [];
        notify();
    } catch {
        // Commutes degrade gracefully: a failed load means an empty list.
    }
}

export async function saveCommute(originStopId, originName, destStopId, destName, label) {
    const res = await authFetch(`${API_BASE}/api/commutes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ originStopId, originName, destStopId, destName, label }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save commute');
    }
    const commute = await res.json();
    cache = [commute, ...cache];
    notify();
    return commute;
}

/** The longest commute name the API accepts. */
export const MAX_LABEL_LENGTH = 100;

/**
 * What to do with a finished rename: save the trimmed text, or keep the
 * current name when the result is empty or unchanged.
 */
export function renameResult(current, typed) {
    const label = typed.trim();
    if (!label || label === current) return { save: false, label: current };
    return { save: true, label };
}

export async function updateLabel(id, label) {
    const res = await authFetch(`${API_BASE}/api/commutes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
    });
    if (!res.ok) throw new Error('Failed to update label');
    cache = cache.map(c => c.id === id ? { ...c, label } : c);
    notify();
}

export async function deleteCommute(id) {
    const res = await authFetch(`${API_BASE}/api/commutes/${id}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete commute');
    cache = cache.filter(c => c.id !== id);
    notify();
}
