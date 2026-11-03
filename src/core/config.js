// src/core/config.js
// The one place the frontend learns where the API lives. Production runs on
// Fly.io in ewr (see api/fly.toml); dev builds use the local API. Set
// VITE_API_BASE to point a dev build somewhere else, e.g. at production:
//   VITE_API_BASE=https://nyc-subway-api.fly.dev npm run dev
// A deployed build can only reach the hosts in vercel.json's connect-src.

export const API_BASE = import.meta.env.VITE_API_BASE
    || (import.meta.env.PROD ? 'https://nyc-subway-api.fly.dev' : 'http://localhost:8080');
