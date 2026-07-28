// src/core/rt-loader.js
// Fetches real-time data as JSON from the Go API server (Phase 5). Protobuf
// decoding and GTFS-RT parsing now happen server-side; the browser just consumes
// clean JSON and no longer bundles gtfs-realtime-bindings.

// Switch to the deployed Cloud Run URL for production in P5-7.
const API_BASE = import.meta.env.PROD
    ? 'https://TODO-cloud-run-url.run.app' // TODO(P5-7): real Cloud Run URL
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
