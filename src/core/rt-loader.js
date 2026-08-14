// src/core/rt-loader.js
// Fetches real-time data as JSON from the Go API server (Phase 5). Protobuf
// decoding and GTFS-RT parsing now happen server-side; the browser just consumes
// clean JSON and no longer bundles gtfs-realtime-bindings.

// Production API runs on Fly.io in ewr — see api/fly.toml.
const API_BASE = import.meta.env.PROD
    ? 'https://nyc-subway-api.fly.dev'
    : 'http://localhost:8080';

// Fetches all live vehicles for the 3D train layer.
// Returns { vehicles: [...], updatedAt: "<RFC3339>" }.
export async function fetchVehicles() {
    const res = await fetch(`${API_BASE}/api/vehicles`);
    if (!res.ok) throw new Error(`vehicles request failed: ${res.status}`);
    return res.json();
}

// Fetches upcoming arrivals for a single station (parent or directional ID).
// Returns { stationId, arrivals: [...], updatedAt: "<RFC3339>" }.
export async function fetchArrivals(stationId) {
    const res = await fetch(`${API_BASE}/api/arrivals/${encodeURIComponent(stationId)}`);
    if (!res.ok) throw new Error(`arrivals request failed: ${res.status}`);
    return res.json();
}

// Fetches the per-trunk status rollup behind the service status list.
// Returns { trunks: [...], upcoming, updatedAt }. Small — ~300 bytes gzipped —
// because it carries counts rather than the alerts themselves.
export async function fetchAlertSummary() {
    const res = await fetch(`${API_BASE}/api/alerts/summary`);
    if (!res.ok) throw new Error(`alert summary request failed: ${res.status}`);
    return res.json();
}

// Fetches service alerts. Defaults to those in effect now (~1.2 KB gzipped);
// includeUpcoming pulls in future planned work as well, which is roughly twenty
// times larger, so it is only worth requesting for a view that shows it.
export async function fetchAlerts(includeUpcoming = false) {
    const url = `${API_BASE}/api/alerts${includeUpcoming ? '?upcoming=true' : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`alerts request failed: ${res.status}`);
    return res.json();
}
