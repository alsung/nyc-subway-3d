import { authFetch } from './auth.js';

const API_BASE = import.meta.env.PROD
    ? 'https://nyc-subway-api.fly.dev'
    : 'http://localhost:8080';

let cache = [];

export async function loadFeatures() {
    try {
        const res = await authFetch(`${API_BASE}/api/features`);
        if (!res.ok) return;
        const data = await res.json();
        cache = data.features ?? [];
    } catch {
        // Features degrade gracefully: a failed load means hasFeature returns
        // false for everything, which matches the anonymous experience.
    }
}

export function hasFeature(name) {
    const f = cache.find(feat => feat.name === name);
    return f?.accessible ?? false;
}

export function getFeatures() {
    return cache;
}
