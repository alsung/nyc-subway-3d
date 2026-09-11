# NYC Subway 3D — Product Design Document

**Version:** 2.0  
**Author:** Alex Sung  
**Status:** Active development  
**Repository:** github.com/alsung/nyc-subway-3d

---

## Table of Contents

1. [Product Summary](#1-product-summary)
2. [Problem Statement](#2-problem-statement)
3. [Competitive Landscape](#3-competitive-landscape)
4. [Use Cases](#4-use-cases)
5. [Architecture Overview](#5-architecture-overview)
6. [Technology Stack](#6-technology-stack)
7. [Phase Roadmap](#7-phase-roadmap)
8. [Phase 1 — Static 3D Map](#8-phase-1--static-3d-map)
9. [Phase 2 — Live Arrivals](#9-phase-2--live-arrivals)
10. [Phase 3 — Live Train Positions](#10-phase-3--live-train-positions)
11. [Phase 4 — Real Trains + Station LOD](#11-phase-4--real-trains--station-lod)
12. [Phase 5 — Go API Server (Fly.io)](#12-phase-5--go-api-server-flyio)
13. [Phase 6 — Performance, Service Alerts + Mobile](#13-phase-6--performance-service-alerts--mobile)
14. [Phase 7 — Map Legibility + Station Detail](#14-phase-7--map-legibility--station-detail)
15. [Phase 8 — Trip Planner + Car Positioning](#15-phase-8--trip-planner--car-positioning)
16. [Phase 9 — User Accounts](#16-phase-9--user-accounts)
17. [Phase 10 — Push Notifications](#17-phase-10--push-notifications)
18. [Phase 11 — AI Agent Layer](#18-phase-11--ai-agent-layer)
19. [Data Sources](#19-data-sources)
20. [API Reference](#20-api-reference)
21. [Test Strategy](#21-test-strategy)
22. [Deployment](#22-deployment)
23. [Out of Scope](#23-out-of-scope)

---

## 1. Product Summary

NYC Subway 3D is a browser-based, real-time visualization of the New York City subway system. It renders all 27 lines, 472 stations, and active train positions on a geographically accurate 3D map built with Three.js and Maplibre GL JS. The map is the primary interface — not a supplementary view bolted onto a list-based app.

The project solves real rider problems: planning trips, knowing when to leave, knowing which car to board for the fastest exit, understanding how service disruptions cascade through the system, and navigating accessibly. It does all of this on a spatial canvas that shows the full system simultaneously — something no existing app provides.

The goal is to be the most technically interesting NYC transit tool that an individual engineer could build without institutional data access.

---

## 2. Problem Statement

The NYC subway is used by ~3.6 million riders daily. Despite the existence of numerous transit apps, riders consistently face the same unresolved friction:

**Trip planning is app-siloed.** Citymapper and Google Maps give you routes but no spatial context. You can't see the system — only your slice of it.

**Car and exit positioning is a separate lookup.** Exit Strategy NYC solves this well in isolation, but it's disconnected from the trip plan. You look up your route in one app, then switch to another to figure out which car to board. Nobody has combined these into a single flow.

**Delays are communicated as lists.** The MTA app shows a text list of affected lines. Riders cannot see how a signal failure on the F at York Street creates a cascade of delays on adjacent lines. A spatial view makes this immediately legible.

**Accessibility is an afterthought.** Only 28% of stations are ADA compliant. No mainstream app lets you plan a route that only uses working elevators, and real-time elevator outage data is publicly available but rarely surfaced at trip-planning time.

**Weekend service changes are opaque.** Planned work restructures service significantly every weekend. Understanding what's running requires reading paragraph-length alerts rather than seeing the map reconfigure itself.

---

## 3. Competitive Landscape

| App | Strengths | What's missing |
|---|---|---|
| MTA official app | First-party data, live arrivals, service alerts, accessibility mode, trip planning | 2D schematic only, no spatial system view, car positioning limited to LIRR/MNR |
| Citymapper | Car positioning for transfers, multi-modal, step-by-step | No system-wide view, no 3D, mobile-only |
| Exit Strategy NYC | Best-in-class car/door positioning for all 469 stops, works offline | Static, no live data, no trip planning, iOS-only pricing |
| Google Maps | Familiar UX, multi-modal, widely trusted | No live train positions, no car positioning, no system-wide view |
| AP Transit | 3D visualization, real-time | No trip planning, no car positioning, less polished |
| Subway Now | Live map, clean UI | 2D only, no trip planning, no car positioning |

**The gap this project fills:** a browser-based tool that combines system-wide 3D spatial context, live GTFS-RT data, trip planning, and car/exit positioning in one interface.

---

## 4. Use Cases

### UC-1: Morning commuter, late for work
Alex opens the app. He types "Penn Station" → "Grand Central." The map highlights the route. Live arrival times show the next 4/5/6 train leaves in 3 minutes. The result tells him: board the **4th car from the front** to exit at the uptown stairs at Grand Central. He makes the train.

### UC-2: Tourist, first time on the subway
A visitor from abroad opens the URL on their phone. They see the whole system in 3D and immediately understand the geographic relationship between Manhattan, Brooklyn, and Queens. They click Times Square. The popup shows 8 lines, next arrivals for each direction, and the exits at street level.

### UC-3: Rider encountering a service disruption
A signal failure is issued on the A/C/E at Jay St. The user sees affected line segments pulse red on the 3D map. Their saved commute (Fulton St → 72nd St) shows a disrupted route and an alternate via the 2/3. They reroute before leaving the building.

### UC-4: Wheelchair user planning a trip
A rider who uses a wheelchair needs elevator-only navigation. They enable accessibility mode. The map dims all stations without working elevators. Their route is recalculated to avoid the inaccessible 14th St–Union Square (elevator broken) and route via 23rd St instead.

### UC-5: Late night rider on a weekend
It's 1am on Saturday. The user looks at the map and immediately sees that F/G service has been rerouted, the A is running local instead of express, and the L is not running at all. Visual diffs on the map show exactly which stops are being skipped and where shuttle buses replace service.

### UC-6: Developer or engineer exploring the codebase
A backend engineer looks at the GitHub repo to understand how the GTFS-RT protobuf pipeline is built, how the Go API server handles concurrent feed fetches with TTL caching, how the geo projection math works, and how the test suite is structured. The code is their product showcase.

---

## 5. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser (Vite + Three.js + Maplibre GL JS + Vanilla JS ES Modules)     │
│                                                                          │
│  src/core/          src/scene/         src/ui/                           │
│  gtfs-parser.js     renderer.js        camera.js                         │
│  gtfs-loader.js     lines.js           filter.js                         │
│  geo.js             trains.js          popup.js                          │
│  color.js                              search.js                         │
│  rt-loader.js                                                            │
│  rt-parser.js                                                            │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ fetch (CORS-proxied / Phase 5: JSON API)
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Go Proxy → Go API Server                                                 │
│                                                                           │
│  Phase 4:  Fly.io (ewr) — CORS passthrough + 30s TTL cache               │
│  Phase 5+: Fly.io (ewr) — full API server, parses protobuf,              │
│            serves /api/arrivals, /api/vehicles, /api/gtfs/*              │
│            background goroutine refreshes all 8 feeds every 30s          │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  MTA Public Feeds                                                         │
│                                                                           │
│  GTFS Static ZIP     → stops.txt, routes.txt, shapes.txt, trips.txt      │
│  GTFS-RT (8 feeds)   → TripUpdate, VehiclePosition (protobuf binary)     │
│  Elevator/Escalator  → live outage data (Phase 7)                        │
│  Service Alerts      → camsys/subway-alerts (protobuf binary)            │
└──────────────────────────────────────────────────────────────────────────┘

Static hosting: Vercel (CDN edge, Vite dist/)
CI/CD:          GitHub Actions (test → build → deploy frontend + backend)
```

> **Interactive architecture diagram** — current Phase 4 state vs. the Phase 5 API-server migration, with cost and setup time breakdown (the diagram predates the move from Cloud Run to Fly.io — see the decision record below): [Phase 4 → Phase 5 Architecture](https://claude.ai/code/artifact/e7cddf84-f2a4-4b4d-925c-05fe26bef020)

---

## 6. Technology Stack

| Technology | Layer | Use case |
|---|---|---|
| Three.js r165 | Frontend / rendering | 3D scene graph, WebGL renderer, TubeGeometry for subway lines, InstancedMesh for trains |
| Maplibre GL JS v5 | Frontend / map | Map tiles, camera, station circle layers, symbol labels, queryRenderedFeatures for click |
| CatmullRomCurve3 | Frontend / rendering | Arc-length-uniform spline sampling via `getPointAt(u)`; `getUtoTmapping` for fraction → t conversion |
| Vite 5 | Build | Dev server with HMR, production bundler via Rollup, tree-shakes Three.js |
| Vanilla JS (ES modules) | Frontend | All app logic as native ES modules; no framework overhead on a WebGL canvas |
| Vitest | Testing | Unit test runner for all `src/core/` modules; runs in Node, no DOM or browser needed |
| Go 1.27 | Backend | HTTP server: CORS proxy (Phase 4), full API server (Phase 5+) |
| log/slog | Backend | Structured JSON logging for each proxied/API request |
| sync.RWMutex | Backend | Thread-safe in-memory feed cache; concurrent reads, serialized writes |
| net/http/httptest | Backend testing | In-memory request/response testing without binding a port |
| MTA GTFS static | Data | `stops.txt` → stations, `routes.txt` → colors, `shapes.txt` → route geometry, `trips.txt` → shape-to-route mapping |
| MTA GTFS-RT | Data | 8 protobuf binary feeds updated every ~30s; `TripUpdate` for arrival times, `VehiclePosition` for train locations |
| Vercel | Infrastructure | Static frontend hosting; global CDN, deploys via Vercel's own Git integration |
| Fly.io | Infrastructure | Containerized Go app in `ewr`: the API server (`nyc-subway-api`, one always-on shared-cpu-1x/512MB machine) |
| Google Cloud (Phases 8–10) | Infrastructure | Firebase Auth and FCM for user accounts and push notifications; not used for hosting the API |
| Firebase Auth (Phase 9) | Auth | Google Sign-In; user identity for saved commutes and notification prefs |
| Firebase Cloud Messaging (Phase 10) | Notifications | Push notifications for departure alerts and delay warnings via service worker |
| Claude API (Phase 11) | AI | Tool-use agent layer for natural language transit queries |
| GitHub Actions | CI/CD | Pipeline: JS tests → build → deploy frontend → Go tests → deploy backend |

---

## 7. Phase Roadmap

| Phase | Name | Status | Key deliverable |
|---|---|---|---|
| 1 | Static 3D Map | Complete | All lines + stations rendered from GTFS data, 2D/3D toggle, station search, line filter |
| 2 | Live Arrivals | Complete | Real protobuf decoding, next arrivals per station/direction from 8 GTFS-RT feeds |
| 3 | Live Train Positions | Complete | Real vehicle positions from GTFS-RT, interpolated between stops on route curves |
| 4 | Real Trains + Station LOD | Complete | Station complexes, major/minor LOD circles, two-column arrival popup, real train sync |
| 5 | Go API Server (Fly.io) | Complete | Replaced the CORS proxy with a full API server; server-side protobuf parsing and a shared in-memory cache |
| 6 | Performance, Service Alerts + Mobile | **Complete** | Startup performance, popup state clarity, MTA service alerts, station badges, arrivals redesign, responsive layout, PWA manifest, keyboard access |
| 7 | Map Legibility + Station Detail | **Next** | Zoom-driven camera, basemap restraint, routes as the subject, building extrusions, station entrances and exits |
| 8 | Trip Planner + Car Positioning | Planned | Origin → destination routing (RAPTOR, transit-only), highlighted route on map, optimal car recommendation; walking legs and Citibike staged after |
| 9 | User Accounts | Planned | Firebase Auth (Google Sign-In), server-side saved commutes, user preferences |
| 10 | Push Notifications | Planned | FCM via service worker; departure reminders, delay alerts for saved commutes |
| 11 | AI Agent Layer | Planned | Claude API tool-use agent; natural language trip queries, proactive commute intelligence |

---

## 8. Phase 1 — Static 3D Map

### Goal
Render the complete NYC subway system — all lines, all stations — in a geographically accurate 3D scene. Work entirely from public GTFS static data. No live feeds required. The app must be usable immediately on load without any server setup.

### Scope
- Parse MTA GTFS static files (`stops.txt`, `routes.txt`, `shapes.txt`, `trips.txt`)
- Project lat/lng coordinates into Three.js XZ world space using cosine-corrected geo projection
- Render each route as a `TubeGeometry` spline along `CatmullRomCurve3` waypoints
- Render each station as a colored `CylinderGeometry` at accurate geographic position
- Smooth 2D ↔ 3D camera toggle with eased tween
- Station search with fly-to camera animation
- Line filter chips (toggle per-line visibility)
- Simulated trains animating along routes (placeholder for Phase 3)
- Embedded fallback data so the app renders with no server needed

### File Structure
```
nyc-subway-3d/
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
├── .gitignore
├── .github/workflows/
│   └── deploy.yml       # test, build, deploy frontend + API
│   └── fly.toml
├── public/
│   └── gtfs/            # MTA GTFS files (downloaded by npm run gtfs in CI)
│       ├── stops.txt
│       ├── routes.txt
│       ├── shapes.txt
│       └── trips.txt
├── src/
│   ├── styles.css
│   ├── main.js          # entry point, wires all modules together
│   ├── core/            # pure logic — no DOM, no Three.js, fully testable
│   │   ├── geo.js           # lat/lng ↔ XZ projection, haversine, downsample
│   │   ├── gtfs-parser.js   # CSV parser + GTFS file parsers + station complexes
│   │   ├── gtfs-loader.js   # fetch GTFS files or fall back to embedded
│   │   ├── rt-loader.js     # fetch vehicles + arrivals from the Go API
│   │   ├── rt-parser.js     # decode protobuf, build arrival index
│   │   └── color.js         # contrast color, hexToRGB
│   ├── data/
│   │   └── embedded.js      # fallback station/route constants
│   ├── scene/           # Three.js + Maplibre — no business logic
│   │   ├── renderer.js      # Maplibre map, Three.js custom layer, station circles
│   │   ├── lines.js         # TubeGeometry per route
│   │   └── trains.js        # InstancedMesh trains + arc-length interpolation
│   └── ui/              # DOM manipulation only
│       ├── camera.js        # orbit controls, tween, setView()
│       ├── filter.js        # line chip toggles
│       ├── popup.js         # two-column station arrival popup
│       └── search.js        # search input + fly-to
└── tests/
    └── unit/
        ├── geo.test.js
        ├── gtfs-parser.test.js
        └── color.test.js
```

### Implementation Details

#### Geo projection (`src/core/geo.js`)
```
geoToXZ(lat, lng):
  x = (lng - CENTER.lng) × SCALE × cos(CENTER.lat × π/180)
  z = -((lat - CENTER.lat) × SCALE)

CENTER = { lat: 40.730, lng: -73.960 }   // midtown Manhattan
SCALE  = 1200                              // ~200×200 Three.js unit canvas
```
The cosine correction on longitude compensates for the fact that degrees of longitude are shorter at 40°N than at the equator (~75km per degree vs 111km). Without this, the map would be horizontally stretched.

#### GTFS parsing (`src/core/gtfs-parser.js`)
Four-stage pipeline:
1. `parseRoutes(routesText)` → `{ [routeId]: { color, name } }`
2. `parseStops(stopsText)` → `{ stations[], childToParent{} }` — keeps `location_type=1` (parent stations) and orphan stops; excludes platforms and entrances
3. `parseShapes(shapesText)` → `{ [shapeId]: [{lat, lng, seq}] }` — sorted by `shape_pt_sequence`
4. `parseTripsToRouteShapes(tripsText, shapePoints)` → `{ [routeId]: [[lat,lng]...] }` — picks the longest shape per route

#### Route rendering (`src/scene/lines.js`)
```
points = coords.map(geoToXZ)                 // project to world space
sampled = downsample(points, 300)            // cap at 300 for GPU budget
curve = CatmullRomCurve3(sampled)            // smooth spline
tube = TubeGeometry(curve, segments, 0.11, 5) // rendered tube
```

#### Camera system (`src/ui/camera.js`)
Orbit camera with spherical coordinates `(θ, φ, r)`. Mouse drag updates θ and φ, scroll wheel updates r. `tweenTo(pos, look)` animates between positions using ease-in-out quadratic over 900ms. `setView('2d')` positions camera at `(0, 75, 0.01)` for top-down; `setView('3d')` at `(-28, 38, 44)` for perspective.

### Test Cases — Phase 1

#### `geo.test.js`
| Test | Assertion |
|---|---|
| Map center projects to (0, 0) | `geoToXZ(40.730, -73.960)` → `{x≈0, z≈0}` |
| East is positive X | lng `-73.9` produces higher x than `-74.0` |
| North is negative Z | lat `40.8` produces lower z than `40.6` |
| Cosine correction applied | 1° longitude produces smaller x than 1° latitude produces z |
| Times Square is west and north of center | x < 0, z < 0 for `(40.7558, -73.9879)` |
| Round-trip inverse projection | `xzToGeo(geoToXZ(lat,lng))` recovers original within 5 decimal places |
| Haversine Times Sq → Grand Central | ~0.8–1.0 km |
| Haversine symmetry | `d(A,B) === d(B,A)` |
| Downsample reduces to ≤ maxPoints+1 | 1000 points → ≤ 301 at maxPoints=300 |
| Downsample preserves first and last point | Always |

#### `gtfs-parser.test.js`
| Test | Assertion |
|---|---|
| `parseCSV` handles UTF-8 BOM | Header row parsed correctly |
| `parseCSV` handles CRLF line endings | Rows parsed correctly |
| `parseCSV` handles quoted fields with commas | Field not split on interior comma |
| `parseCSV` skips blank lines | Row count excludes empty lines |
| `parseRoutes` prefixes color with # | `EE352E` → `#EE352E` |
| `parseRoutes` falls back to `MTA_ROUTE_COLORS` | Blank `route_color` uses hardcoded map |
| `parseStops` includes parent stations (type=1) | `location_type=1` stops in results |
| `parseStops` includes orphan stops | Stops with no parent and `location_type != 2` included |
| `parseStops` excludes platforms (type=0 with parent) | Child platforms excluded |
| `parseStops` excludes entrances (type=2) | Station entrances excluded |
| `parseStops` builds `childToParent` map | `123N → 123` populated |
| `parseShapes` sorts by sequence | Points ordered by `shape_pt_sequence` |
| `parseTripsToRouteShapes` picks longest shape | Route A uses `A_NORTH` (3 pts) over `A_SHORT` (2 pts) |
| `parseGTFS` integration | Returns all three expected keys |
| `MTA_ROUTE_COLORS` covers all major lines | 1,4,A,B,F,G,J,L,N,7,S all present |
| All colors are valid hex | `/^#[0-9A-Fa-f]{6}$/` match |

#### `color.test.js`
| Test | Assertion |
|---|---|
| N/Q/R yellow → `#000` | Bright yellow needs dark text |
| A/C/E blue → `#fff` | Dark blue needs light text |
| 1/2/3 red → `#fff` | Red needs light text |
| White → `#000` | |
| Black → `#fff` | |
| Works without `#` prefix | `'FCCC0A'` same as `'#FCCC0A'` |
| L line gray → `#000` | Light gray needs dark text |
| `hexToRGB('#FFFFFF')` → `{r:255,g:255,b:255}` | |
| `hexToRGB('#000000')` → `{r:0,g:0,b:0}` | |

---

## 9. Phase 2 — Live Arrivals

### Goal
Replace simulated arrival data with real MTA GTFS-RT data. Station popups show actual next arrival times pulled from 8 parallel protobuf feeds every 30 seconds.

### Scope
- Add `gtfs-realtime-bindings` for protobuf decoding in the browser
- Decode all 8 MTA GTFS-RT feeds in parallel via `Promise.allSettled`
- Normalize directional stop IDs (`127N`/`127S` → `127`) for parent station matching
- Build arrival index: `{ [stopId]: [{routeId, direction, minutes, tripId}] }`
- Refresh every 30s; show staleness indicator if feed is >90s old
- Update phase status badge in UI stats bar

### Key Implementation Notes

#### Stop ID normalization
MTA uses directional stop IDs: `127N` = Times Square northbound platform, `127S` = southbound. Parent station ID from `stops.txt` is `127`. The arrival index must be keyed on both the directional and parent IDs.

```js
const parentId = stopId.replace(/[NS]$/, '')
index[stopId] = [...entries]
index[parentId] = [...entries]   // allows lookup by either
```

#### Fan-out fetch pattern
```js
const results = await Promise.allSettled(
  Object.values(GTFS_RT_FEEDS).map(url =>
    fetch(`${PROXY}/proxy?url=${encodeURIComponent(url)}`)
      .then(r => r.ok ? r.arrayBuffer() : null)
  )
)
// allSettled: one failed feed does not block the others
```

#### Arrival filtering
Discard arrivals that are: more than 60 seconds in the past, more than 60 minutes in the future, or missing both `arrival.time` and `departure.time`. Sort remaining by seconds away.

### Test Cases — Phase 2

| Test | Type | Assertion |
|---|---|---|
| Stop ID normalization strips N/S suffix | Unit | `'127N'.replace(/[NS]$/, '')` === `'127'` |
| Stop ID normalization leaves non-directional IDs unchanged | Unit | `'A27'` unchanged |
| Arrival index keyed on both directional and parent | Unit | Both `index['127N']` and `index['127']` populated |
| Arrivals sorted by seconds | Unit | Ascending sort on `seconds` field |
| Past arrivals filtered out | Unit | `secondsAway < -60` excluded |
| Far-future arrivals filtered out | Unit | `secondsAway > 3600` excluded |
| `Promise.allSettled` — one feed failure does not fail others | Integration | 7/8 feeds succeed despite one rejection |
| Stale indicator triggers at 90s | Unit | `Date.now() - lastUpdate > 90000` → stale class applied |

---

## 10. Phase 3 — Live Train Positions

### Goal
Replace simulated trains with real vehicle positions from the GTFS-RT `VehiclePosition` feed. Trains are positioned accurately on their routes and move smoothly between GTFS-RT update cycles.

### Scope
- Parse `VehiclePosition` entities from decoded feeds
- Map `routeId` → `CatmullRomCurve3` for position interpolation
- Match vehicle stop ID to nearest point on route curve using arc-length sampling
- Orient train mesh along track tangent
- Switch from individual `BoxGeometry` meshes to `InstancedMesh` for performance
- Display train count in stats bar

### Key Implementation Notes

#### Arc-length-uniform position sampling
GTFS-RT `VehiclePosition` gives a `currentStopSequence` and `stopId`. Trains are positioned on the route curve by finding the arc-length fraction that minimizes distance to the matched stop's geographic coordinates.

```js
// True arc-length sampling (NOT curve.getSpacedPoints which is t-uniform):
for (let i = 0; i <= SAMPLE_COUNT; i++) {
  const pt = curve.getPointAt(i / SAMPLE_COUNT)  // arc-length fraction
  // find closest sample to station coordinates
}
// Convert best arc-length fraction → t parameter for tangent calculation:
const t = curve.getUtoTmapping(bestI / SAMPLE_COUNT)
```

`getSpacedPoints` is t-uniform, not arc-length uniform, and clusters samples near low-curvature segments. `getPointAt` is the correct method.

#### InstancedMesh for performance
~400–600 trains run simultaneously. Individual meshes = 400–600 draw calls per frame. `InstancedMesh` = 1 draw call for all trains of the same line color.

```js
const mesh = new THREE.InstancedMesh(trainGeo, trainMat, MAX_TRAINS)
// Per frame:
trains.forEach((t, i) => {
  matrix.setPosition(t.position)
  matrix.makeRotationY(t.bearing)
  mesh.setMatrixAt(i, matrix)
})
mesh.instanceMatrix.needsUpdate = true
```

One `InstancedMesh` per line color (23 lines = 23 draw calls, not 600).

### Test Cases — Phase 3

| Test | Type | Assertion |
|---|---|---|
| `t` clamped to [0,1] during interpolation | Unit | Progress > 1 does not extrapolate beyond route end |
| Interpolation returns midpoint at progress=0.5 | Unit | Position is halfway between two known stops |
| InstancedMesh count matches active train count | Integration | `mesh.count` === `vehiclePositions.length` |
| Bearing computed from tangent | Unit | `atan2(tangent.x, tangent.z)` matches expected heading |
| Stale vehicle positions discarded | Unit | Positions with `timestamp` > 120s old are excluded |

---

## 11. Phase 4 — Real Trains + Station LOD

### Goal
Make the map legible at every zoom level and ensure every train shown is a real one. Station rendering switches from Three.js geometry to Maplibre native layers. Same-name stations merge into a single dot at low zoom. Arrival data is split into a permanent north/south two-column view.

### Scope
- Replace Three.js `CylinderGeometry` station meshes with Maplibre native `circle` layers
- Two-tier LOD: merged station complexes below zoom 13, individual station circles at zoom 13+
- Major stations (≥3 routes) render larger than minor stations at all zoom levels
- Station complexes: group same-name stations into one centroid dot; popup merges arrivals from all constituent stations
- Arrival popup redesign: permanent two-column north/south split; no direction toggle
- Station name labels at zoom 13+
- Real train positions from GTFS-RT `VehiclePosition` (replacing simulated trains)
- GTFS static files downloaded in CI before build (`npm run gtfs`); removed from gitignore

### Key Implementation Notes

#### Station complex merging (`src/core/gtfs-parser.js`)
```
buildStationComplexes(stations):
  group stations by s.name
  for each group:
    centroid.lat = mean(s.lat for s in group)
    centroid.lng = mean(s.lng for s in group)
    complex = { name, lat, lng, stationIds: [s.id, ...] }
  return complexes[]
```

Complexes are used for the low-zoom source. The `stationGroups` Map derived from complexes provides fast `stationId → siblings[]` lookup for merging arrivals from all platforms of a named station.

#### Maplibre two-tier LOD (`src/scene/renderer.js`)
Two GeoJSON sources, four circle layers:

```
source: 'station-complexes'  (maxzoom 13)
  layer: 'station-complexes-major'  minzoom 10, filter: major == 1
  layer: 'station-complexes-minor'  minzoom 11, filter: major == 0

source: 'stations'           (minzoom 13)
  layer: 'station-circles-major'   filter: major == 1
  layer: 'station-circles-minor'   filter: major == 0
  layer: 'station-labels'          symbol layer
```

`major` is stored as integer (1 or 0) in GeoJSON properties. Integer avoids Maplibre filter type coercion issues that occur when comparing strings to numbers.

#### Merged arrival lookup (`src/main.js`)
Click handler splits `feat.properties.stationIds` (pipe-separated string) to get all constituent IDs. `getArrivals` deduplicates by `tripId` across all sibling station arrival lists and returns a merged, sorted array.

#### Two-column arrival popup (`src/ui/popup.js`)
```
popup layout:
  .popup-line-select      // route pill row
  .popup-directions       // flex row
    .popup-dir-col        // Uptown / N column
    .popup-dir-divider    // 1px separator
    .popup-dir-col        // Downtown / S column
```

Both directions always visible; no toggle button. Each column shows up to 4 arrival times.

### Test Cases — Phase 4

| Test | Type | Assertion |
|---|---|---|
| `buildStationComplexes` groups stations by name | Unit | Two stations named "Times Sq-42 St" → one complex |
| Centroid is average of constituent lat/lng values | Unit | Complex lat/lng equals mean of member station coords |
| `stationIds` array contains all constituent IDs | Unit | Complex with 3 members → `stationIds.length === 3` |
| Major classification correct | Unit | Station with routeCount ≥ 3 → `major: 1` |
| Minor classification correct | Unit | Station with routeCount < 3 → `major: 0` |
| Pipe-separated stationIds round-trips correctly | Unit | `ids.join('|').split('|')` recovers original array |
| Merged arrivals deduplicated by tripId | Unit | Same tripId from two sibling stations appears once |
| Merged arrivals sorted by minutes | Unit | Ascending sort after merge |

---

## 12. Phase 5 — Go API Server (Fly.io)

### Goal
Move all GTFS-RT fetching and protobuf parsing to a dedicated Go API server on Fly.io. The browser receives clean JSON. Every user benefits from a shared server-side cache rather than each fetching independently from MTA.

### Scope
- Replace the CORS proxy with a Go API server deployed to Fly.io
- Background goroutine fetches and parses all 8 GTFS-RT feeds every 30s
- In-memory cache shared across all concurrent users
- New endpoints: `GET /api/arrivals/:stationId`, `GET /api/vehicles`, `GET /api/gtfs/:file`
- Browser JS: remove protobuf decoding; replace with simple `fetch('/api/...')` calls
- CI: add a `flyctl deploy` job for `api/`; retire the proxy deploy
- GTFS static stays baked into the Vercel build (see Design Decisions) — the server keeps its own in-memory copy for future server-side use

### Tickets

| Ticket | Description | Status |
|---|---|---|
| P5-1 | API scaffold — HTTP server, CORS middleware, `/health`, stub routes | ✅ Done |
| P5-2 | Load GTFS static ZIP at startup, serve `GET /api/gtfs/:file` | ✅ Done |
| P5-3 | Background goroutine — refresh 8 GTFS-RT feeds every 30s, decode protobuf server-side (last-known-good per feed) | ✅ Done |
| P5-4 | `GET /api/arrivals/:stationId` — server-side `buildArrivalIndex`, computed per request | ✅ Done |
| P5-5 | `GET /api/vehicles` — server-side `parseVehiclePositions` | ✅ Done |
| P5-6 | Frontend migration — drop `gtfs-realtime-bindings`, fetch JSON from `api/` instead of decoding protobuf in-browser | ✅ Done |
| P5-7 | Deploy `api/` to Fly.io; point the frontend PROD endpoint at `nyc-subway-api.fly.dev` | ✅ Done |
| P5-8 | CI cutover (`api/` tests + Fly deploy, `pull_request` trigger), config cleanup, PR to master | ✅ Done |

Backend (P5-1…P5-5) is complete and verified against live MTA feeds. Remaining work is ordered 6 → 7 → 8 (each depends on the previous) and lands in a single PR to master.

### Key Implementation Notes

#### Background goroutine architecture
```go
func startFeedRefresher(cache *Cache) {
    go func() {
        refresh()            // immediate first fetch
        ticker := time.NewTicker(30 * time.Second)
        for range ticker.C {
            refresh()
        }
    }()
}

func refresh() {
    var wg sync.WaitGroup
    for _, feed := range gtfsFeedURLs {
        wg.Add(1)
        go func(url string) {
            defer wg.Done()
            body, _ := fetchMTAFeed(url)
            parsed := parseGTFSRT(body)  // protobuf decode in Go
            cache.Set(url, parsed)
        }(feed)
    }
    wg.Wait()
}
```

All 8 feeds fetched concurrently in Go goroutines. Cache is populated once at startup and refreshed every 30s — no per-user MTA request.

#### JSON API endpoints
```
GET /api/arrivals/:stationId
  → { stationId, arrivals: [{ routeId, direction, minutes, tripId }], updatedAt }
  Keyed on both directional (127N) and parent (127) IDs; caller gets both directions.

GET /api/vehicles
  → { vehicles: [{ routeId, tripId, stopId, currentStatus, stopTimeUpdate: [{ stopId }] }], updatedAt }
  MTA subway feeds carry no GPS — the client derives each train's position from
  its stop sequence along the route geometry (no lat/lng/bearing exists).

GET /api/gtfs/stops.txt
GET /api/gtfs/shapes.txt
GET /api/gtfs/trips.txt
GET /api/gtfs/routes.txt
  → raw GTFS static file text, loaded from ZIP at server startup

GET /health
  → { status: "ok", lastRefresh: "<ISO timestamp>", feedsLoaded: 8 }
```

#### Frontend changes
```js
// Before (Phase 4):
const feeds = await loadRT()              // 8 protobuf fetches in browser
const index = buildArrivalIndex(feeds)   // protobuf decode in browser JS

// After (Phase 5):
const arrivals = await fetch(`/api/arrivals/${stationId}`).then(r => r.json())
```

Removes `gtfs-realtime-bindings` from the bundle (~180 KB parsed).

#### Fly.io deployment
```yaml
# .github/workflows/deploy.yml
- name: Deploy API → Fly.io
  run: cd api && flyctl deploy --remote-only --ha=false
  env:
    FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

`--ha=false` is load-bearing, not an optimization: the feed cache lives in-process,
so a second machine would poll MTA independently and serve inconsistent data.
Exactly one instance is a correctness requirement of this design.

#### Cost
One always-on `shared-cpu-1x` / 512 MB machine in `ewr`: **~$3.32/month**. Traffic
barely moves this — the server's floor is set by the always-on background refresher,
not by request volume, and each response is served from memory (`/api/vehicles`
gzips to ~14 KB). The same box comfortably serves hundreds of concurrent users.

#### Why not Cloud Run (decision record)
Cloud Run was the original plan and was abandoned during P5-7. Its execution model
allocates CPU **only during request processing** — but this server's whole design is a
background goroutine that must tick every 30s whether or not anyone is asking. Making
that work requires `--no-cpu-throttling` plus `--min-instances=1`, and Cloud Run then
rejects fractional CPU outright:

```
ERROR: spec.template.spec.containers.resources.limits.cpu: Invalid value specified
for cpu. Total cpu < 1 is not supported with cpu always allocated (unthrottled).
```

That forces a full always-on vCPU: **~$46/month versus ~$3.32 on Fly.io** for identical
behavior. Cloud Run is an excellent fit for request-scoped handlers; it is a poor fit
for a long-lived in-memory cache with a background refresher. Fly.io sells exactly what
this architecture wants — a small always-on VM — and already hosted the Phase 1–4 proxy.

GCP is still the intended home for Firebase Auth and FCM in Phases 8–10; that setup is
independent of where this API runs.

### Design Decisions & Trade-offs

Phase 5 involved several deliberate choices where the obvious approach wasn't the one we took. Recording them here so the reasoning survives.

#### Decode once server-side (the whole premise)
Previously every browser fetched all 8 GTFS-RT protobuf feeds and decoded them client-side with `gtfs-realtime-bindings` (~180 KB). Moving the fetch + decode to one Go server means MTA is hit once per 30s regardless of how many users are connected, every client gets clean JSON, and the library leaves the bundle. The trade-off is a server to run and pay for — ~$3.32/month for one always-on Fly.io machine.

#### Last-known-good per feed (vs. all-or-nothing per cycle)
The old client rebuilt its entire view every cycle, inserting `null` for any feed that failed — so a single flaky feed made that line's trains blink out. The server instead updates only the feeds that succeed each cycle and keeps the previous data for any that failed (each with its own `fetchedAt`). A transient failure degrades gracefully to slightly-stale data rather than disappearing trains. This is strictly more resilient than the behavior it replaced.

#### Arrivals computed per request (vs. precomputed on refresh)
`minutes-until-arrival` is relative to *now*. If the server computed it once per 30s refresh and served that for the whole window, every countdown would be up to 30s wrong. So `/api/arrivals/:id` builds the index fresh on each request using `time.Now()`. The cost — rebuilding an in-memory index per request — is microseconds at personal scale, not worth caching.

#### Lazy per-station arrivals (Option B) — the main UX trade-off
When wiring the frontend to the API, the browser needed a way to get arrivals. Two options:

- **Option A — global index.** Add an "all stations" endpoint, fetch the full arrival index every 30s, keep the popup lookup synchronous (instant, in-memory).
- **Option B — lazy per-station.** The 30s loop fetches only `/api/vehicles` (needed for the 3D trains). A station's arrivals are fetched on demand when its popup opens, behind a brief "Loading…" state.

|  | Option A — Global | Option B — Lazy *(chosen)* |
|---|---|---|
| Popup arrivals appear | Instantly (already in memory) | ~50–150 ms later, warm (behind loading state) |
| Backend work | Needs a **new** all-stations endpoint | **None** — uses `/api/arrivals/:id` as built |
| Bandwidth | Ships the entire index (~100–300 KB) every 30s to every client, viewed or not | Only fetches a station's arrivals when someone opens it |
| Popup code | Synchronous | Async (ripples to 3 call sites) |
| Cold-start risk | None on popup | Would apply if the machine scaled to zero — avoided by `min_machines_running = 1` |

**We chose Option B.** It needs no additional backend work, and it leans into the whole point of the migration — a shared server cache that *saves* bandwidth. Shipping every station's arrivals to every client every 30s, when a user only ever looks at one station at a time, works against that goal. The one downside — a network round-trip on popup open — is made effectively invisible by opening the popup *immediately* in a loading state and filling the arrival rows when the fetch resolves (~50–150 ms warm; imperceptible). The only real risk — a 1–3 s cold-start stall after idle — is not inherent to Option B; it is a deploy setting, resolved in P5-7 by never scaling the machine to zero (`min_machines_running = 1`), which the background feed refresher requires anyway.

A station *complex* spans several GTFS IDs (Times Sq = `127` + `725` + `R16` …), so a popup fetches each member ID in parallel and merges the results deduped by `tripId` — one round-trip regardless of how many platforms the complex has.

#### Vehicles carry only `stopId`, and default to STOPPED_AT
MTA's subway feeds publish **no GPS** — position is derived client-side from a train's stop sequence along the route geometry. So `/api/vehicles` serializes each `stopTimeUpdate` as just `{stopId}` (the only field the renderer reads), keeping the payload lean even though each of ~700 vehicles carries its whole remaining stop list. And when a vehicle's `current_status` is absent, the server defaults it to `STOPPED_AT` to match the original frontend behavior — deliberately *not* the protobuf spec's own default of `IN_TRANSIT_TO`, so trains render exactly as they did before.

### Test Cases — Phase 5

| Test | Type | Assertion |
|---|---|---|
| `GET /api/arrivals/:id` returns JSON array | Integration | Response has `Content-Type: application/json` |
| Arrivals sorted ascending by minutes | Unit | First element has lowest `minutes` value |
| Cache serves data if MTA unreachable | Unit | Stale cache entry returned on fetch error |
| Background goroutine refreshes on 30s interval | Unit | `time.NewTicker(30 * time.Second)` invoked |
| Concurrent requests hit cache, not MTA | Integration | 100 concurrent GET /api/arrivals → 1 MTA request |
| `/api/gtfs/stops.txt` returns station data | Integration | Response contains `stop_id` in first 100 bytes |
| `/health` includes `lastRefresh` timestamp | Unit | Field present and parseable as RFC3339 |
| `GET /api/vehicles` returns stop sequence | Unit | Each vehicle object has a `stopTimeUpdate` array |

---

## 13. Phase 6 — Performance, Service Alerts + Mobile

### Goal
Three threads: make the app load fast, make it honest about what it knows (service
alerts and empty states), and make it usable on a phone.

### Scope
- **Startup performance** — stop blocking the UI on third-party map tiles; measured 2.1s → 0.26s to interactive
- **Popup state clarity** — distinguish *loading* / *no trains scheduled* / *request failed* / *data delayed*
- **Service alerts** — ingest MTA's alerts feed; badge affected stations, explain disruptions in the popup, and provide a full alerts view
- **Mobile** — responsive layout, touch gestures, PWA install
- Lighthouse score target: ≥90 Performance, ≥95 Accessibility, 100 PWA

### Tickets

| Ticket | Description | PR |
|---|---|---|
| P6-1 | Startup performance — don't block `init()` on `map.on('load')`; lower initial pitch and animate to 3D after load; re-measure | PR 1 |
| P6-2 | Popup state clarity — replace the ambiguous `—` with distinct loading / no-service / error / stale states | PR 2 |
| P6-3 | Alerts backend — fetch `camsys/subway-alerts` on its own interval, cache, expose `GET /api/alerts` | PR 3 |
| P6-4 | Alerts UI (subtle) — badge on affected stations, disruption detail in the popup, enriching P6-2's empty state | PR 3 |
| P6-5 | Alerts view — dedicated full-breakdown panel reachable from top-level navigation | PR 3 |
| P6-6 | Responsive layout — chip bar, search, popup → bottom sheet | PR 4 |
| P6-7 | Touch gestures — pinch-zoom, two-finger rotate | PR 4 |
| P6-8 | PWA manifest, icons, Lighthouse pass | PR 4 |

P6-1 comes first: it is the largest user-visible win and independent of everything else.
P6-2 precedes the alerts work because the generic states stand on their own, and the
alert data then enriches them — instead of "No trains scheduled," an affected station
can say *why*.

**Deferred to a follow-up:** map-level treatment of alerts (recoloring or pulsing
affected line segments). Deliberately not in the initial pass — with 142 active alerts
observed in a single sample, map-wide highlighting risks becoming visual noise. Revisit
once the subtle treatment shows how dense real alert data actually is.

### Key Implementation Notes

#### Installability and audit scores (P6-8)

Lighthouse against production, before and after:

| Category | Before P6-8 | After P6-8 | After the perf work |
|---|---|---|---|
| Performance | 45 | 48 | **56** |
| Accessibility | **100** | **100** | **100** |
| Best Practices | **100** | **100** | **100** |
| SEO | 82 | **100** | **100** |

All three columns are measured against production. An earlier draft reported an
"after" Performance figure from a local `vite preview` run, where it read 42 — a
different environment, not a comparable number.

The third column follows the station-matching optimisation described below.

**SEO** was two concrete failures. There was no meta description, and `robots.txt`
returned **200 `text/html`** — the SPA rewrite in `vercel.json` serves `index.html`
for any path that is not a real file, so crawlers were parsing 1.4 KB of markup as
robots syntax. That is the same catch-all that once served the app shell for missing
GTFS files and kept a broken data pipeline invisible for weeks. Both `robots.txt` and
`sitemap.xml` are now real files in `public/`.

**Performance is 45 and is not being chased.** The breakdown is FCP 0.9 s and CLS
0.018 — both good — against a Total Blocking Time of **3,690 ms**. That is the main
thread parsing and executing 1.57 MB of Three.js and MapLibre and then building the
3D scene. Lighthouse has no concept of "this is a WebGL application," and the only
real fix is code-splitting the 3D engine or moving scene construction off the main
thread. That was treated as a separate project and has since been done, though
not in the way this paragraph predicted — see "Where the blocking time actually
went" below. The one cheap win available here was taken:
`preconnect` for the tile and API origins, which Lighthouse measured at 316 ms and
300 ms of avoidable handshake wait.

**Two startup numbers, and they measure different things.** `scripts/measure-startup.mjs`
reports ~436 ms; Lighthouse reports 7.4 s Time to Interactive. Both are correct. The
first is when the search box exists and accepts input; the second is when the main
thread is quiet enough to *guarantee* responsiveness. Cite the first as "time to first
interaction," not as TTI.

**Icons are generated, not hand-drawn.** `scripts/build-icons.mjs` renders every PNG
from two committed SVGs using Playwright's Chromium — already a devDependency — so the
binaries in `public/` are reproducible rather than opaque. There are two source
drawings because one asset does not scale: `icon.svg` carries three crossing routes
through an interchange dot, which collapses into a smudge at favicon size, so
`favicon.svg` reduces the same idea to a symmetric X with a larger dot. The maskable
variant is inset 20%, since Android crops it to whatever shape the launcher uses.

#### Where the blocking time actually went

The section above assumed the 3.7 s of blocking came from bundle size, and that
the fix was code-splitting Three.js and Maplibre. **That assumption was wrong,
and measuring it was what proved so.**

Lighthouse's own attribution: **`parse = 5 ms`, `eval = 3,678 ms`.** Nothing to
win from splitting — the code is not slow to *load*, it is slow to *run*.

Instrumenting each startup phase under the same 4× CPU throttle Lighthouse uses:

| Phase | Before | After |
|---|---|---|
| GTFS fetch + parse | 457 ms | 458 ms |
| waiting on map load | 1,166 ms | 1,129 ms |
| `buildLineMeshes` | 54 ms | 51 ms |
| **`buildStationTByRoute`** | **1,264 ms** | **171 ms** |
| `buildSimulatedTrains` | 3 ms | 3 ms |
| `addStationLayer` | 8 ms | 9 ms |
| **total to scene ready** | **3,389 ms** | **2,195 ms** |

**One function was 37% of startup.** It matched every station against every
sampled point on every curve — 29 routes × 496 stations × 2001 samples, close to
29 million `Math.hypot` calls — and recomputed each station's local coordinates
inside the route loop.

Three changes, none of them structural:

1. **Hoist the coordinate conversion.** It depends only on the station: 14,384
   calls become 496.
2. **A bounding box per curve**, grown by the match radius. A station outside it
   skips the 2001-point scan entirely, and a route passes near a few dozen of 496
   stations. This is where the time went. It is **exactly equivalent, not an
   approximation**: the original discards its result unless the nearest sample is
   within the radius, and a station outside the grown box has none by construction.
3. **Compare squared distances.** `Math.hypot` pays for overflow-safe scaling
   these values never need — measured **3.4× slower** on this loop.

The function had no test coverage, so ten characterisation tests were written
against the original first. Equivalence was then checked against the real feed:
both implementations agree on all 29 routes and all **1,522 station-`t` entries**
exactly.

Production result: Lighthouse TBT **1,570 → 850 ms**, Performance **48 → 56**,
and `scene` over the real network 2,005 → 1,727 ms. Time to first interaction is
unchanged at ~476 ms, because that path was never blocked by this work.

**What remains is not ours.** The residual ~1.1 s is network wait on Stadia tiles
plus library initialisation. Performance will not approach 90, and that is not
the goal — the goal was that the main thread stop blocking for over a second on
work that takes a tenth of that.

#### Startup performance (P6-1)
Profiling with the Chrome DevTools Protocol showed the app is **not** CPU-bound: 82.8% of
the time to interactive was spent idle, with all JS execution totalling ~600 ms
(`gtfs-parser.js` 73 ms, `three.js` 64 ms). The blocker is that `init()` waits on
Maplibre's `load` event, which does not fire until the style and initial tiles arrive
from Stadia. The opening camera (`pitch: 56`) compounds this by pushing the horizon back
and enlarging the visible tile set.

The fix is ordering, not optimisation: render the search, filter chips, and popup shell
immediately, and let the map fill in behind them. Starting at a low pitch and animating
to the 3D view after load reduces the initial tile burst on top of that.

> **Withdrawn measurement.** An earlier draft of this section cited a 17,128 ms
> production baseline. It does not reproduce — measuring the same deployment with the
> same markers gives 2,113 ms. The original figure was most likely captured while
> Stadia was returning 401s on tiles, which stalls the pre-P6-1 code indefinitely
> because every UI element sat behind `map.on('load')`. It has been removed rather
> than corrected in place, since nothing about the run is trustworthy.

**Three changes shipped:**

1. `createMap` is called *before* `await loadAndParseGTFS()`, so Stadia's tile fetch
   overlaps the GTFS download instead of queueing behind it.
2. The search box, filter chips, and popup are built as soon as GTFS resolves. Only the
   Three.js scene waits on the map's `load` event. Chip toggles made before the line
   meshes exist are recorded in a `filterState` map and applied once they are — state
   rather than a queue, so it stays idempotent.
3. The map opens at `pitch: 0` and eases to the 3D view after load (`introToThreeD`).
   The animation sets pitch and bearing only, never `center`, so it cannot pull the map
   away from a station the user selected while it was still loading; it defers past any
   in-flight `flyTo`, and is skipped entirely if the user moved the camera by hand.

**Measured on the real deployments**, same harness, same network. "Interactive" is the
search input hitting the DOM; "scene ready" is the first successful RT refresh.

Two comparisons, because they answer different questions:

| | Interactive | Scene ready | Reqs before interactive |
|---|---|---|---|
| Production, pre-P6-1 | 2,113 ms | 3,061 ms | 35 |
| P6-1, before the GTFS fix | 263 ms | 1,991 ms | 6 |
| **Production today (P6-1 + real GTFS)** | **468 ms** | **2,005 ms** | 13 |

**8.0× (2,113 → 263 ms)** isolates the ordering change. Both of those builds predate the
GTFS static-data fix below, so neither downloaded the 6.4 MB payload — an equal footing
that measures the reorder and nothing else.

**4.5× (2,113 → 468 ms)** is what users actually get. Today's build is faster *and* doing
strictly more work: it downloads the full station dataset the old build was silently
skipping. Median of 9 cold-cache runs, range 452–567 ms.

The gap between 263 ms and 468 ms is the honest cost of that data. Loading a real map of
the subway is worth 200 ms.

A local test under 10 Mbps throttling shows where the next bottleneck is: interactive
went 9,876 ms → 7,687 ms, a much smaller ~22% win, because once the ordering is fixed
**interactive is gated on the 6.4 MB GTFS download** — and the map, now fetching in
parallel, competes with it for the same bandwidth. That is the case for precomputing
GTFS into compact JSON at build time (deferred ticket); it is the only change that moves
the constrained number much further.

Three things about measuring this that cost real time and are worth writing down:

- **Stadia serves tiles keyless from `localhost` but 401s from a deployed origin.** Local
  testing structurally cannot catch a missing `VITE_STADIA_API_KEY`. Any measurement that
  matters has to run against a deployed URL.
- **The style JSON returns 200 even when every tile 401s**, so `map.on('load')` still
  fires and the map reports itself loaded while rendering nothing. It is a silent
  failure, which is exactly why the withdrawn baseline above went unnoticed for so long.
- **A three-run median hid a 2.8× outlier.** The first sample of this build read 621 ms
  on runs of 460 / 621 / 1,741 ms; nine runs put it at 468 ms with a 452–567 ms range.
  Over a real network with a multi-megabyte download, three samples is not a measurement.

#### GTFS static data was missing from every deployment (fixed 2026-08-11)
Until this date the deployed app served **45 stations out of ~496**. `/gtfs/*.txt` was
absent from the deployment, the SPA rewrite answered those paths with `index.html` at
HTTP 200, and `gtfs-loader` fell back to the embedded dataset — producing a map that
looked plausible while being roughly 9% of the network.

The cause was two independent deploy pipelines. The GitHub Actions workflow ran
`npm run gtfs` and deployed with `vercel deploy --prebuilt`; Vercel's Git integration
separately built the same commit using `vercel.json`'s `buildCommand`, never ran the
download, and won the production alias. The same commit produced two deployments that
differed: one served `stops.txt` as 63,371 bytes of CSV, the other as 777 bytes of HTML.

The fix moves the download into npm's `prebuild` hook, so it runs inside whichever build
produces the deployed output. `scripts/verify-build.mjs` now fails the build if
`dist/gtfs` is missing, truncated, or contains markup, and the app shows a banner rather
than silently degrading. **Collapsing the two pipelines into one is still outstanding.**

#### Service alerts (P6-3)
MTA publishes a dedicated GTFS-RT alerts feed at
`https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts`. It is
public, requires no key, and decodes with the protobuf bindings the API server already
depends on — no new dependencies.

Verified against the live feed: 142 `Alert` entities, ~370 KB. The eight real-time feeds
already fetched contain essentially no alerts (0–1 per feed), so this data is genuinely
additional rather than something already being discarded.

Each alert carries human-readable `headerText` plus `informedEntity` entries that name a
route, a stop, or both:

```
header:   "[7][7X] trains are running with delays in both directions.
           The last stop on some Flushing-bound [7][7X] is 111 St or Mets-Willets Point."
informed: routeId="7"  stopId=""      ← route-level
informed: routeId=""   stopId="705"   ← station-level
```

Stop IDs are parent station IDs (`705`, no N/S suffix), so they key directly against the
existing arrival index with no normalization. Alerts refresh on a slower interval than
train positions (~60s) — they change far less often and the payload is roughly five times
larger than a single real-time feed.

#### Alerts UI — subtle pass (P6-4)
At the station level, an affected station carries a small badge on its map circle, and
the popup explains the disruption in words rather than leaving an unexplained gap. This
is what turns P6-2's generic "No trains scheduled" into something actionable: a rider
looking at Times Sq during a Broadway-line suspension should read *why* there are no
trains, not be left guessing whether the app is broken.

#### Alerts view (P6-5)
The app currently has no routing; everything renders into one view. Rather than adding a
second HTML entry point — which would duplicate the shell and reload Three.js and
Maplibre — the alerts breakdown is an overlay panel over the warm map, addressed by URL
hash (`#alerts`) so it stays linkable and the browser back button behaves. No router
dependency.

The alert data is re-rendered in-app rather than linking out to MTA's own status page.
Linking out sends the reader away and discards the one thing this project can do that a
text list cannot: show a disruption spatially.

```
┌──────────────────────────────────────┬──────────────────────┐
│                                      │  SERVICE ALERTS   ✕  │
│                                      ├──────────────────────┤
│        3D map stays visible          │ ①②③④⑤⑥⑦ⒶⒸⒺⒷⒹⒻⓂ    │  status strip
│        and interactive               │ ⒿⓏⓁⓃⓆⓇⓌⒼ           │  tinted by severity
│                                      ├──────────────────────┤
│   ● affected stations pulse          │ ⚠ SUSPENDED (2)      │
│     when an alert is selected        │ ┌──────────────────┐ │
│                                      │ │ ⓃⓆⓇⓌ Manhattan  │ │
│                                      │ │ Broadway line     │ │  click → map flies
│                                      │ │ 14 stations       │ │  and highlights
│                                      │ └──────────────────┘ │
│                                      │ ⏱ DELAYS (5)         │
│                                      │ 🔧 PLANNED WORK (9)  │
└──────────────────────────────────────┴──────────────────────┘
```

**Line status strip** — a compact grid of route bullets, each tinted by its worst active
severity (good service / delays / suspended). Scannable at a glance, and doubles as a
filter: selecting a bullet narrows the list to that route.

**Grouped by severity, not chronology** — Suspended, then Delays, then Planned work. What
is broken belongs at the top; a 3am weekend track replacement should not outrank a
suspended trunk line.

**Selecting an alert drives the map** — the view flies to the affected corridor, unaffected
lines dim, and affected stations pulse. This is the feature worth building: it makes the
"see the whole system" thesis concrete, and it is precisely what MTA's own status page
cannot do.

**Entry point** — a button beside the 2D/3D controls showing a live count tinted by worst
active severity (`⚠ 12`), fading to neutral gray when nothing is wrong. It doubles as an
ambient system-health signal without anything being opened. A drawer rather than a
full-page takeover, because keeping the map visible is what makes the map-driving
behavior work at all; on small viewports it becomes a bottom sheet, aligning with P6-6.

**Density caveat** — a single sample of the live feed carried 142 active alerts, most of
them routine planned work. Without severity grouping and route filtering the panel
degenerates into a wall of text nobody reads, so planned work should collapse by default.
Worth validating against real data once P6-3 lands and the actual distribution is visible.

### Key Implementation Notes — Mobile

#### PWA manifest
```json
{
  "name": "NYC Subway 3D",
  "short_name": "Subway 3D",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#07071a",
  "theme_color": "#07071a",
  "icons": [{ "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }]
}
```

#### Responsive popup
Below 640px viewport width, the popup switches from a floating card to a bottom sheet with a drag handle. Arrival columns stack vertically instead of side-by-side. The route pill row scrolls horizontally.

#### Performance targets
- Time to Interactive: < 3s on 4G
- Map frame rate: ≥ 58fps during pan on a mid-range Android device
- JS bundle: < 600 KB gzipped (Phase 5 removed the protobuf library: 414 KB gzipped as of P5-6)

---

## 14. Phase 7 — Map Legibility + Station Detail ✅

### Goal

Make the subway the subject of its own map, and make the 3D view earn its place
rather than being a toggle. Phase 6 finished the app's *behavior*; this phase is
about what a visitor sees in the first three seconds.

### Why this comes before the trip planner

The default view was audited by rendering it and looking at it. At city zoom the
camera is pitched, so New Jersey — Hackensack, Passaic, Clifton — occupies the
top third of the screen while the subway compresses into the middle. Highway
shields (`95`, `278`, `495`, `GSP`) compete with the subject. Every station is an
identical white dot, and the route lines are dim threads: you cannot tell the 1
from the L.

A trip planner inside an app that reads as bare gets judged as bare. This phase
is also mostly deletion, which makes it cheap relative to its effect.

### What the mockups established

Four frames were rendered against the live app with style changes applied at
runtime, rather than drawn:

1. **Current** — pitched overview, basemap and subway at equal visual weight.
2. **Flat + basemap suppressed** — shields, POIs and out-of-city labels hidden,
   roads at 25% opacity, pitch zeroed.
3. **Routes as the subject** — the same, plus routes drawn as flat lines in their
   own colors, interchanges enlarged, local stops reduced to ticks.
4. **Street zoom, tilted** — tube geometry running under the Midtown grid.

**The finding that changed the plan: restraint alone does almost nothing.** Frame
2 was expected to carry most of the improvement and did not — quieting the
basemap just made a dim map dimmer. The subway only becomes legible in frame 3,
when the routes themselves become the boldest thing on screen. Suppression is
necessary but not sufficient.

### Two representations, swapped by zoom

Frame 3 draws routes as **Maplibre line layers**, not the Three.js tubes, and the
tubes are hidden to render it. That is the architecture, not a shortcut:

| Zoom | Camera | Routes | Why |
|---|---|---|---|
| below ~14 | flat | Maplibre line layers | Tube geometry degrades to a thread at distance; flat lines stay crisp |
| above ~14 | tilted | Three.js tubes | Tubes show depth and stacking; flat lines cannot |

This is what makes the 3D feel intentional. Tilt at overview zoom costs
legibility and buys nothing; tilt on approach is the thing nothing else on the
web does. Pitch becomes a function of zoom rather than a button.

### Scope

**Overview treatment**
- Zoom-driven pitch; the 2D/3D buttons become an override rather than the mechanism
- Hide highway shields, POIs, airport and out-of-city place labels; roads to ~25% opacity
- Routes as Maplibre line layers below the tube threshold, 2.2–5px, real route colors
- Station hierarchy: interchanges as anchors, single-line stops as ticks

**Close treatment**
- ~~**Building extrusions**~~ — **built, measured and cut.** The tubes still
  float over a flat grid, which is a real loss, but extrusions cost roughly 40%
  of the frame rate in their cheapest shippable form. See "Buildings versus
  legibility" below for both findings: the color result, which was worth
  keeping, and the frame-rate result, which ended it.
- **Complex-aware labels.** At street zoom "Times Sq-42 St" currently renders
  three times, once per platform, because each is a separate GTFS station. The
  popup already collapses complexes; the label layer does not.

**Station entrances**
- Render entrances and exits at street zoom from MTA's own dataset

### Buildings versus legibility

Extrusions were mocked before being specified, and the first attempt made the map
worse. At `fill-extrusion-opacity: 0.72` on a mid-gray `#2a2d34`, the translucent
massing sits on top of the tubes and desaturates them: the blue 8 Avenue trunk
and the red 7 Avenue trunk both lose most of their color. The 3D got better and
the subject got worse — which is the wrong trade for a subway map.

Four variants were rendered from the same camera:

| Opacity | Color | Result |
|---|---|---|
| 0.72 | `#2a2d34` | Buildings dominate; the red trunk nearly vanishes into the massing |
| 0.40 | `#2a2d34` | Lines recover somewhat, but the buildings go *milky* — the skyline reads as fog rather than towers |
| **0.55** | **`#15171c`** | **Towers keep their silhouette and the lines keep their saturation** |
| 0.12 | `#15171c` | Buildings nearly gone; every line at full strength |

**The color matters more than the opacity, and that was not the expected
result.** The obvious lever is transparency, and lowering it only replaced one
problem with another: a light-gray extrusion at low alpha becomes a haze over
everything instead of receding. A dark material absorbs light rather than
scattering it back at the camera, so at `#15171c` the buildings hold their shape
at *higher* opacity than the gray ones could manage while the route colors stay
clean. Anyone tuning this later will reach for opacity first, as this attempt
did; the fix is the color.

**Opacity is therefore a state, not a constant.** Roughly 0.55 while browsing,
dropping toward 0.12 when a route or line is selected — context when scanning,
clarity when following something. That is the same dimming behavior Phase 8's
route highlighting needs, so building it here is earlier work rather than extra
work.

### Buildings versus frame rate — why they were cut

The color work solved legibility. It did not survive the frame-rate
measurement, taken while dragging Midtown at zoom 15.2 and pitch 55 — the exact
camera the feature exists to serve — by counting Maplibre `render` events:

| Buildings | 4× CPU throttle | unthrottled |
|---|---|---|
| none | 27.0–27.5 fps | 36.0–37.4 fps |
| `render_height > 60` | 17.0–17.5 fps | 21.1–21.8 fps |
| `render_height > 25` | — | 16.4 fps |
| every building | 8.0 fps | 10.6 fps |

Height filtering was the planned mitigation and is not enough. The most
aggressive filter — Manhattan's genuine towers and nothing else — still costs
**~40%**, and drawing them all costs **~70%**. Those ratios held across repeat
runs and across throttling, which is what marks this as GPU work rather than
main-thread work.

**The baseline is the actual finding.** With no extrusions at all the map does
not reach 60 fps while panning; it sits in the thirties. Three.js and Maplibre
share one WebGL context and one frame, so the app is GPU-bound *before*
buildings are added. Extrusions are not paying an ordinary cost — they are
spending headroom that was already gone. No `fill-extrusion` setting fixes that,
which is why tuning was abandoned rather than continued.

The implementation is not in the tree. It was about 65 lines, and it worked;
rebuilding it is an afternoon if the budget ever changes.

**Measuring this correctly required two attempts.** The first counted
`requestAnimationFrame` callbacks, which fire at the display's refresh rate
whether or not the map repainted — it reported 119 fps for every configuration,
including ones that were visibly stuttering. A rAF counter measures the monitor,
not the app.

### Follow-up: the shared WebGL context

The thirty-something baseline is the open question this phase found and did not
answer. Three.js and Maplibre share a context, so the custom layer may be
forcing GL state changes that break Maplibre's batching — a cost paid on every
frame at every zoom, not only when buildings are on.

This is the highest-leverage frontend performance work left, and it gates
buildings: at a 60 fps baseline the `height > 60` filter would land near 36 and
become shippable. It is an investigation with an uncertain payoff rather than a
ticket — profile a single frame's GL calls first, then decide whether there is
anything to reclaim.

### Station entrances — what the data supports, and what it does not

The original idea was an X-ray of station interiors: elevators, stairs, exits,
concourses. The data was checked before scoping, and it supports about half of
that.

MTA publishes **2,120 entrance records across 485 stations, every one with
coordinates**, keyed on `gtfs_stop_id` — the same key `stations.json` already
uses, so it joins directly:

| Type | Count |
|---|---|
| Stair | 1,629 |
| Easement — Street | 164 |
| Station House | 112 |
| **Elevator** | **102** |
| Easement — Passage | 57 |
| Escalator | 18 |
| Stair/Escalator | 10 |
| Ramp | 10 |
| Underpass / Walkway / Overpass / other | 18 |

It also carries `entry_allowed` and `exit_allowed`, so **exit-only stairs are
marked** — genuinely useful, and something the major mapping apps surface poorly.

**What MTA does not publish: internal layout.** No floor plans, no mezzanines,
nothing that says "this stair connects the uptown platform to the mezzanine."
That ruled a cutaway out of *this* dataset, and the entrance points are what it
does support: standing on the street, which stair do I take, and is it an
entrance? At street zoom a station becomes six to twelve labeled points instead
of one dot.

An earlier version of this section went further and said a station interior
"cannot be built from open data." That was wrong, and the correction matters
enough to leave visible rather than quietly edit away.

### OpenStreetMap has some of what MTA does not

The standard way to get station interiors would be **GTFS-Pathways**
(`pathways.txt` plus `levels.txt`), which OTP2 consumes for platform-to-platform
routing. MTA's subway feed is ten files and neither is among them, so OTP2 offers
nothing here that RAPTOR will not already do.

OpenStreetMap does carry station geometry, and a spike fetched all of it —
1,341 platform ways, 2,475 indoor ways and 4,079 stop_area relations across the
five boroughs — to find out how much.

**Platform geometry is complete.**

| | |
|---|---|
| stations with at least one platform polygon | **496 / 496** (150 m radius) |
| stations with a `level` value | 476 / 496 |
| platforms attached to a station | 972 |
| asset size | 222 kB raw, **55 kB gzipped** |

**Interior mapping is not.** `indoor=yes` turns out to mean furniture — the 100
"indoor ways" first counted at Huguenot were 98 benches. Filtering to structural
features only (`corridor`, `room`, `area`, `level`, `wall`):

| | |
|---|---|
| structural indoor ways system-wide | 739, of 2,475 raw |
| complexes with any | 84 / 445 |
| complexes with real interior detail (10 or more) | **2** — Grand Central, 34 St-Herald Sq |

An earlier draft of this section claimed full indoor mapping existed at the major
complexes. It does not. That claim came from sampling seven stations with
bounding boxes about 550 m wide, which swept in neighboring buildings, and from
counting `indoor=yes` furniture as structure. Both mistakes inflated the result
in the same direction, which is the kind of agreement that should have prompted a
check rather than confidence.

### Depth is not in the data

`level` is a storey index within a station, not a distance below the street:

| Station | `level` | actual |
|---|---|---|
| 191 St | −2 | deepest in the system, about 55 m |
| Clark St | −2 | deep |
| Wall St | −1, −2 | shallow |
| Grand Central-42 St | −1, −2, −4 | deep, multi-level |

191 St and Wall St share a value because both have two floors. There is no
absolute-depth tag to fall back on: `layer` (1,761 occurrences) is a drawing-order
hint, and `ele` appears exactly once.

Elevated track is the part that reads correctly — Smith-9 Sts at `4` genuinely is
the highest station in the system, Queensboro Plaza `2,3`, Coney Island `2`.

### What this supports, and what it does not

Not an X-ray of station interiors. What the data supports is **real platform
geometry stacked by level at every station** — actual shapes, orientation, count,
and internal ordering, so the shuttle reads as sitting above the 7. With the
entrances already drawn, that is substantially more than a dot, it uses the third
dimension for something only the third dimension shows, and unlike the building
extrusions above the cost is trivial: about ten polygons, one station at a time.

It cannot show corridors, cannot say which stair reaches which platform, and
cannot show that 191 St is deep.

**Licensing is an open question.** OSM is ODbL. Extracting and redistributing a
platforms asset creates a derivative database carrying attribution and
share-alike obligations that the MTA feed does not. The basemap already credits
OpenStreetMap, so this is probably fine — but it needs reading properly before
anything ships.

**Live elevator outages are a separate feed.** The existing `subway-alerts` feed
was searched across 190 alerts and carries essentially none — one passing mention
of an entrance closure. MTA publishes ADA outages separately, and that feed must
be verified before the UI claims an elevator is out of service. Showing a
wheelchair user a working elevator that is broken is worse than showing nothing.

### What shipped

| PR | |
|---|---|
| #43 | Overview treatment — zoom-driven camera, basemap restraint, routes as Maplibre line layers, station hierarchy |
| #44 | One station size at every zoom; fixed `setPitch` cancelling an in-flight `flyTo` |
| #45 | Station complexes grouped by MTA `complex_id` rather than name — 38 wrongly merged stations to 0 |
| #46 | Building extrusions measured at 40–70% of frame rate and cut; findings recorded above |
| #47 | Corridor detection — where routes share a right-of-way |
| #48 | Co-running routes drawn as parallel strands |
| #49 | Street entrances for the selected station |
| #50 | A route became several polylines (plumbing, no behavior change) |
| #51 | Every branch of a route drawn — 51 stations with no line reaching them, to 0 |

Complex-aware labels landed inside #43 rather than as their own ticket.

### The branches were not in the plan

#50 and #51 exist because the parallel strands exposed them. Drawing one shape
per route had left **51 stations with no line reaching them** — every stop on the
A's Rockaway branch, the 5's White Plains Rd, the 2's Nostrand Av, the W's Sea
Beach, the N/Q's Second Avenue, the R's 4 Av locals. They still rendered as dots,
so the map looked complete while missing track, and a Rockaway-bound A could not
be positioned at all because there was no curve to put it on.

Selecting a *different* single shape does not fix it: the most-frequent pattern
is usually a short-turn, and the M's busiest shape is 9.5 km against the line's
29.6. The fix was to stop selecting one — a greedy cover that keeps adding shapes
while they contribute new ground. 29 polylines became 38, and all 496 stations
now match a route.

### Still open

- **Tube appearance at street zoom.** Lit `MeshStandardMaterial` against a dark
  ground reads dimmer than the flat layer's raw color, and the zoom-14 handoff
  now invites the comparison.
- **The shared WebGL context** — see the follow-up section above. Still the
  highest-leverage frontend performance work, and still what gates buildings.
- **Live elevator outages**, before any accessibility claim is made.
- **Platform geometry in 3D** — the reduced form of the X-ray idea, sized and
  de-risked by the OSM spike above. One fetch script, a 55 kB asset, and a render
  layer alongside the entrances one. Weigh it against Phase 8 rather than
  assuming it comes first: the idea was compelling partly because it promised the
  inside of Times Sq, and the spike established that promise cannot be kept.

---

## 15. Phase 8 — Trip Planner + Car Positioning

### Goal
User inputs origin and destination. The app computes time-dependent transit itineraries from the GTFS timetable — offering both the fastest journey and the one with fewest transfers — highlights the route on the 3D map, and recommends which car to board based on exit position at the destination. Walking legs and multimodal comparison (Citibike) are staged after; see the plan below.

### Scope
- Extend the GTFS download to include `stop_times.txt`, `transfers.txt` and the calendar files
- Implement RAPTOR in the Go API — time-dependent, bicriteria over arrival time and transfers
- Use live GTFS-RT predictions inside the realtime horizon, scheduled times beyond it
- Highlight route segments on the 3D map (selected lines brighten, others dim)
- Fly camera to frame the route
- Show turn-by-turn panel: line, direction, stops, transfer instructions
- Recommend front/middle/back of train based on destination exit
- Car positioning data stored as static JSON: `{ [stopId + direction]: { optimal_car, exit_name, notes } }`

### Key Implementation Notes

#### Why not a station graph with Dijkstra

The obvious approach — build a graph of stations, weight edges by travel time, run
Dijkstra — **cannot express the thing that dominates a real journey: waiting.** A
fixed edge weight says "Bedford Av to 1 Av takes 3 minutes." It cannot say the L
runs every 4 minutes at rush hour and every 20 at midnight, and it cannot say you
just missed one. Transit routing is *time-dependent*, and a static-weight graph
throws that away.

The algorithms designed for this take a timetable directly rather than a graph.

#### Staged plan

Multimodal routing is three separate problems with very different costs. Each
stage ships something usable on its own.

| Stage | Scope | New infrastructure |
|---|---|---|
| **1. Transit-only** | subway + transfers, time-dependent | none — runs in the existing Go API |
| **2. Walking legs** | door-to-station, station-to-door | none initially; OSM only if needed |
| **3. Citibike + true multimodal** | compare modes on time and cost | OTP2 as a separate service |

Stage 1 answers most of what a rider actually wants and needs no new service.
Deferring stages 2 and 3 keeps the "do we need a second host" decision until
there is evidence rather than a guess.

#### Stage 1 — RAPTOR in Go

[RAPTOR](https://www.microsoft.com/en-us/research/wp-content/uploads/2012/01/raptor_alenex.pdf)
(Round-bAsed Public Transit Optimized Router) works directly on the timetable with
no preprocessing. It proceeds in rounds, where round *k* finds the best journeys
using exactly *k* trips, which makes it naturally **bicriteria**: it produces a
Pareto set over arrival time *and* number of transfers. That maps directly onto
what riders ask for — "fastest" and "fewest changes" are different answers, and
RAPTOR yields both from one run.

```
improve(round k):
  for each route touching a stop improved in round k-1:
      board the earliest trip catchable at that stop
      ride it, improving arrival times at every downstream stop
  apply footpath transfers between nearby stops
```

**Data required.** The download script currently extracts 4 of the 10 GTFS files.
Routing additionally needs:

| File | Size | Purpose |
|---|---|---|
| `stop_times.txt` | 34.8 MB | every stop event of every trip — the timetable itself |
| `transfers.txt` | small | station-to-station transfer rules and minimum times |
| `calendar.txt`, `calendar_dates.txt` | small | which services run on which dates |

**Measured, not assumed.** A Go prototype parsed the real feed into the compact
representation and reported:

| | |
|---|---|
| parse time | **547 ms** for 565,093 stop-time rows |
| pattern grouping | **32 ms** |
| compact arrays | **10.8 MB** |
| peak heap | **35.6 MB** |
| trips / platforms / patterns | 20,621 / 989 / **218** |

So the 512 MB machine is not a constraint, and the parse is a one-off cost at
startup alongside the GTFS download the API already performs. **218 patterns is
the number that matters for RAPTOR** — the algorithm scans routes per round, and
218 is small enough that round count, not route count, will dominate.

The API already downloads and extracts the GTFS ZIP, keeping 4 of 10 files, so
this extends existing machinery rather than adding a pipeline. The 34.8 MB of raw
`stop_times` should be parsed and discarded rather than retained in `gtfsFiles`
alongside the served text.

#### Three traps the data revealed

Checked before scoping, because each one fails silently rather than loudly:

1. **Times exceed 24:00.** The maximum arrival time in the feed is `28:02:00`, and
   **18,876 rows sit at or past midnight**. Parsing these as clock times drops the
   entire late-night network without erroring. They must stay as seconds from the
   service day's start.
2. **`transfers.txt` and `stop_times.txt` disagree on granularity.** Stop times use
   platforms (`101N`, `101S`); transfers use parent stations (`101`). A
   station-level transfer has to be expanded to the platform pairs it connects, or
   no transfer ever matches anything.
3. **150 of 613 transfers cross stations** — `127 → 725` (Times Sq 1/2/3 to the 7),
   `112 → A09`. These are the out-of-system walks that make journeys work, and they
   are a different case from a same-station platform change.

Only **7 service IDs** exist (Weekday, Saturday, Sunday and holiday variants) with
**6 exception dates**, so calendar handling is genuinely simple.

#### The realtime angle

Most trip planners route on the published schedule. This project already
maintains a live arrival index built from GTFS-RT, which means the router can use
**predicted** departure times rather than scheduled ones for the near horizon —
so a delayed train produces a different itinerary, not just a different countdown.

Realtime covers only currently-active trips, roughly the next 30–60 minutes, so
the design has to fall back to schedule beyond that horizon and be explicit in the
UI about which is which.

#### Alternatives considered

**Connection Scan Algorithm (CSA)** — scans a single array of connections sorted
by departure time. Simpler to implement than RAPTOR and
[comparable in performance on small to medium networks](https://naviqore.github.io/documentation/raptor.html),
which the ~500-station subway certainly is. Its basic form optimises arrival time
only; bicriteria variants exist but are more involved. **A reasonable fallback if
RAPTOR proves fiddly**, at the cost of losing the free transfer-count dimension.

**Transfer Patterns / Trip-Based Routing** — faster at query time, but both
require substantial preprocessing. Aimed at networks far larger than one subway
system; not worth the build complexity here.

**Self-hosted OpenTripPlanner 2** — the complete answer, and the only one that
gets Citibike (via GBFS) and real pedestrian routing (via OSM). It is a JVM
service that builds an in-memory graph from OSM + GTFS, so it needs its own
sizing and its own host; it will not share the 512 MB machine. Deferred to
stage 3, where its cost is justified by capability nothing else provides.

**Hosted routing APIs** — mostly a dead end. Mapbox Directions has no transit at
all. Google Directions does, but their terms have historically restricted
displaying Google-sourced results on a non-Google map, which would be
disqualifying for a MapLibre app — verify against current terms before relying on
it. [Navitia.io](https://www.navitia.io/) is the most viable of these: an
open-source engine with a hosted API and permissive terms. Set against all of
them: the Stadia incident showed what a silent third-party failure costs, and
routing is the core of the product rather than a basemap.

#### Car positioning data (`src/data/car-positions.json`)
```json
{
  "127S_downtown": {
    "optimal_car": "front",
    "car_number": "1-2",
    "exit": "42 St / 8 Ave exit",
    "notes": "Board front 2 cars for direct access to A/C/E mezzanine"
  }
}
```

Data sourced from Exit Strategy NYC documentation and MTA station layout diagrams. Keyed by `stopId + direction`.

#### Route highlighting
When a route is selected:
1. All non-route line tubes: `material.opacity → 0.1`, `emissiveIntensity → 0.05`
2. Route segments: `material.opacity → 1.0`, `emissiveIntensity → 0.8`
3. Camera tweens to a position that frames the bounding box of all route stations
4. Station meshes on the route pulse gently

### Test Cases — Phase 8

| Test | Type | Assertion |
|---|---|---|
| Single-hop journey | Unit | Adjacent stations on one line resolve with zero transfers |
| Journey requiring a transfer | Unit | Uses a transfer when no direct service exists |
| Pareto set is genuinely Pareto | Unit | No returned journey is beaten on both arrival time and transfers |
| Departure time changes the answer | Unit | Same origin/destination at 08:00 and 02:00 differ — the property a static graph cannot express |
| Just-missed departure waits | Unit | Query one second after a departure returns the following trip |
| Service calendar respected | Unit | A weekday-only trip is not used for a Sunday query |
| Realtime beats schedule inside the horizon | Unit | A delayed trip in GTFS-RT shifts the itinerary |
| Falls back to schedule beyond the horizon | Unit | Query hours ahead uses scheduled times, and says so |
| Unreachable destination | Unit | Returns an empty Pareto set rather than an error |
| Car position lookup | Unit | `stopId + direction` resolves to expected `optimal_car` |

---

## 16. Phase 9 — User Accounts

### Goal
Introduce persistent, server-side user identity using Firebase Auth. Users sign in with Google to save commutes, preferences, and notification settings that follow them across devices.

### Scope
- Firebase Auth with Google Sign-In provider
- Auth state persisted in browser; JWT sent with API requests
- The API server validates Firebase JWT on protected endpoints
- Saved commutes stored in Firestore: `users/{uid}/commutes[]`
- Maximum 5 saved commutes per user
- "My Commute" shortcut in the UI: one tap to show saved route arrival times
- Settings page: notification preferences, default zoom, preferred direction

### Key Implementation Notes

#### Auth flow
```
User clicks "Sign in with Google"
→ Firebase Auth popup (Google OAuth)
→ Firebase returns ID token (JWT)
→ Browser includes token in Authorization header on all /api/* requests
→ API middleware: firebase-admin.VerifyIDToken(token)
→ uid extracted; requests are scoped to that user's Firestore documents
```

#### Firestore data model
```
users/{uid}
  displayName: string
  email: string
  createdAt: timestamp

users/{uid}/commutes/{commuteId}
  originId: string       // GTFS stop_id
  originName: string
  destId: string
  destName: string
  label: string          // "Morning commute", user-editable
  createdAt: timestamp
```

#### Anonymous → authenticated migration
Users who saved commutes in `localStorage` (Phases 1–4) are prompted to sign in. On sign-in, `localStorage` commutes are migrated to Firestore and local storage is cleared.

---

## 17. Phase 10 — Push Notifications

### Goal
Alert users before their train arrives and when their commute is disrupted, even when the app is not open in the foreground.

### Scope
- Firebase Cloud Messaging (FCM) via service worker
- Notification types: departure reminder ("Your 6 train leaves 14th St in 3 min"), delay alert ("Your A train is running 12 min late")
- User sets notification preferences per saved commute: alert window (e.g., 5/10/15 min before scheduled departure), delay threshold
- The API server schedules notification dispatch based on GTFS-RT data
- Service worker handles background message receipt and shows system notification

### Key Implementation Notes

#### Service worker registration
```js
navigator.serviceWorker.register('/sw.js')
const messaging = firebase.messaging()
const token = await messaging.getToken({ vapidKey: VAPID_KEY })
// Store token in Firestore under users/{uid}/fcmTokens[]
```

#### Notification dispatch
A scheduled job on the API server (every minute) checks:
1. For each user with notifications enabled, load their saved commutes
2. For each commute, check GTFS-RT arrivals at the origin station
3. If next arrival is within the user's alert window → send FCM push via `firebase-admin.Messaging.Send`
4. Deduplicate: store `{ tripId, notifiedAt }` in Firestore to avoid repeat alerts for the same trip

#### Delay alerting
Compare current `TripUpdate.arrival.delay` against the user's delay threshold. If threshold exceeded for a trip on the user's commute route, dispatch a delay alert notification.

---

## 18. Phase 11 — AI Agent Layer

### Goal
Add a natural language interface powered by Claude API tool use. Users can ask questions like "What's the fastest way from Astoria to the West Village right now?" and receive a reasoned, real-time answer that accounts for live arrivals, service alerts, and the user's saved commutes.

### Scope
- Claude API integration with tool use (function calling)
- Tool definitions that expose the app's data layer to the model
- Chat input UI accessible from the main map view
- Agent response displays reasoning and highlights the recommended route on the map
- Proactive commute intelligence: "Your usual 8:42am 4 train is running 8 minutes late — you have time for coffee"

### Tool Definitions

```js
const tools = [
  {
    name: "get_arrivals",
    description: "Get next train arrivals at a station by name or ID",
    input_schema: {
      properties: {
        station_name: { type: "string" },
        route_id: { type: "string", description: "Optional — filter by route" }
      }
    }
  },
  {
    name: "plan_route",
    description: "Find the best route between two stations",
    input_schema: {
      properties: {
        origin: { type: "string" },
        destination: { type: "string" },
        depart_at: { type: "string", description: "ISO 8601 datetime, defaults to now" }
      }
    }
  },
  {
    name: "get_service_status",
    description: "Get current service alerts and delays for a line or all lines",
    input_schema: {
      properties: {
        route_id: { type: "string", description: "Optional — omit for all lines" }
      }
    }
  },
  {
    name: "highlight_route",
    description: "Highlight a route segment on the 3D map",
    input_schema: {
      properties: {
        station_ids: { type: "array", items: { type: "string" } },
        route_id: { type: "string" }
      }
    }
  }
]
```

### Agent Architecture
```
User query → Claude claude-sonnet-5
  → tool_use: get_arrivals("14 St-Union Sq")
  → tool_result: [{ route: "4", minutes: 2 }, { route: "6", minutes: 5 }]
  → tool_use: plan_route("14 St-Union Sq", "72 St")
  → tool_result: { legs: [...], totalMinutes: 18, optimalCar: "front 3 cars" }
  → final text response + highlight_route side effect → map update
```

The `highlight_route` tool is the bridge between the AI layer and the 3D map: Claude decides which route to show, and the tool call triggers the existing map highlight function.

---

## 19. Data Sources

| Source | URL | Format | Update frequency | Auth required |
|---|---|---|---|---|
| GTFS Static (subway) | `http://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip` | ZIP (CSV files) | A few times per year | None |
| GTFS-RT 1/2/3/4/5/6/7/S | `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs` | Protobuf | ~30s | None |
| GTFS-RT A/C/E | `.../nyct%2Fgtfs-ace` | Protobuf | ~30s | None |
| GTFS-RT B/D/F/M | `.../nyct%2Fgtfs-bdfm` | Protobuf | ~30s | None |
| GTFS-RT G | `.../nyct%2Fgtfs-g` | Protobuf | ~30s | None |
| GTFS-RT J/Z | `.../nyct%2Fgtfs-jz` | Protobuf | ~30s | None |
| GTFS-RT N/Q/R/W | `.../nyct%2Fgtfs-nqrw` | Protobuf | ~30s | None |
| GTFS-RT L | `.../nyct%2Fgtfs-l` | Protobuf | ~30s | None |
| GTFS-RT SIR | `.../nyct%2Fgtfs-si` | Protobuf | ~30s | None |
| Service Alerts | `.../camsys%2Fsubway-alerts` | Protobuf | ~30s | None |
| Elevator/Escalator | `.../nyct%2Fgtfs-elevator-escalator` | Protobuf | ~5min | None |
| Supplemented GTFS | `https://rrgtfsfeeds.s3.amazonaws.com/gtfssupplemented.zip` | ZIP (CSV) | Hourly | None |
| NYC Ferry GTFS | `https://nycferry.connexionz.net/rtt/public/utility/gtfs.aspx` | ZIP (CSV) | Periodic | None |
| CitiBike GBFS | `https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json` | JSON | ~30s | None |
| MTA Ridership by Car | NY State Open Data | CSV | Historical | None |

---

## 20. API Reference

### Phase 4 — Go Proxy (Fly.io) — retired 2026-08-12

Removed in the Phase 6 cleanup. Nothing has called it since the frontend moved to
the JSON API in P5-6; kept here as a record of the Phase 1–4 architecture.

```
GET /proxy?url=<encoded-mta-feed-url>
GET /health

Response headers:
  X-Cache: HIT | MISS
  Content-Type: application/x-protobuf
  Access-Control-Allow-Origin: *
```

The proxy only forwards to `api-endpoint.mta.info` and `rrgtfsfeeds.s3.amazonaws.com`. All other target URLs return 403.

### Phase 5+ — Go API Server (Fly.io)

```
GET /api/arrivals/:stationId
  → [{ routeId, direction, minutes, tripId }, ...]

GET /api/vehicles
  → [{ vehicleId, routeId, lat, lng, bearing, stopId, timestamp }, ...]

GET /api/gtfs/stops.txt
GET /api/gtfs/shapes.txt
GET /api/gtfs/trips.txt
GET /api/gtfs/routes.txt
  → raw GTFS static file text (loaded from ZIP at server startup)

GET /health
  → { status: "ok", lastRefresh: "<RFC3339>", feedsLoaded: 8 }

Response headers:
  Content-Type: application/json (or text/plain for /api/gtfs/*)
  Access-Control-Allow-Origin: *
  X-Cache: HIT | MISS
```

### Frontend Modules (public API surface)

```js
// src/core/geo.js
geoToXZ(lat, lng) → { x, z }
xzToGeo(x, z)    → { lat, lng }
haversineKm(a, b) → number
downsample(points, maxPoints) → points[]

// src/core/gtfs-parser.js
parseCSV(text)                  → Object[]
parseRoutes(text)               → { [routeId]: RouteInfo }
parseStops(text)                → { stations: Station[], childToParent: {} }
parseShapes(text)               → { [shapeId]: ShapePoint[] }
parseTripsToRouteShapes(t, s)   → { [routeId]: [lat,lng][] }
parseGTFS(stops, routes, shapes, trips) → GTFSData
buildStationComplexes(stations) → Complex[]

// src/core/color.js
contrastColor(hex) → '#000' | '#fff'
hexToRGB(hex)      → { r, g, b }
```

---

## 21. Test Strategy

### Principles
- **Only `src/core/` is unit-tested.** Scene and UI code depends on Three.js and the DOM — both require a browser to run meaningfully. Tests live in `tests/unit/` and run in Node via Vitest with zero DOM setup.
- **Go backend is fully unit-tested** using `net/http/httptest`. No live network calls in tests.
- **Integration tests** (Phase 2+) use fixture protobuf binaries checked into `tests/fixtures/` — real snapshots of MTA feeds captured at a point in time.
- **No mocks for core logic.** Functions in `src/core/` take plain data in and return plain data out. Mocking is never needed.

### Running tests
```bash
# JavaScript unit tests
npm test                    # run once
npm run test:watch          # watch mode
npm run test:coverage       # with V8 coverage report

# Go backend tests
cd api && go test ./...
cd api && go test ./... -v      # verbose
cd api && go test ./... -race   # race detector

# CI (runs automatically on every push and PR)
# See .github/workflows/deploy.yml
```

### Coverage targets
| Module | Target |
|---|---|
| `src/core/geo.js` | 100% |
| `src/core/gtfs-parser.js` | 100% |
| `src/core/color.js` | 100% |
| `api/` (handler logic) | >90% |
| `api/routing.go` (Phase 8 — RAPTOR) | 100% |

Scene and UI modules are excluded from coverage requirements — they are tested manually and via visual inspection.

---

## 22. Deployment

### Frontend (Vercel)

Vercel's Git integration owns frontend deploys. Every push builds on Vercel using
`vercel.json`'s `buildCommand`; `master` goes to production, every other branch to a
preview URL. No GitHub Actions job is involved.

```bash
# One-time setup (only needed for manual deploys)
npm i -g vercel
vercel link   # creates .vercel/project.json

# Manual deploy — normally unnecessary
npm run build
vercel deploy --prod
```

> The workflow used to deploy the frontend *as well*, and the two pipelines silently
> diverged — see "GTFS static data was missing from every deployment" in section 13.
> There is deliberately only one frontend deploy path now.

`vercel.json` configures:
- Build command: `npm run build`
- Output directory: `dist/`
- SPA rewrite: all routes → `index.html`
- Asset cache headers: `Cache-Control: public, max-age=31536000, immutable` for hashed chunks

### Go Proxy — Phase 4 (Fly.io) — retired 2026-08-12

The `proxy/` directory, its CI job, and the `nyc-subway-proxy` Fly app were removed in
the Phase 6 cleanup. The frontend has talked to the Go API server since P5-6.

For the record, it ran on region `ewr` (Newark), 256 MB memory, auto-stop when idle, and
a `GET /health` check every 15s.

### Go API Server — Phase 5 (Fly.io)

```bash
# One-time setup
flyctl apps create nyc-subway-api

# Manual deploy (from the repo root)
cd api && flyctl deploy --remote-only --ha=false

# Automatic: push to master triggers GitHub Actions → deploy.yml
```

`api/fly.toml` configures: region `ewr`, 512 MB memory, `min_machines_running = 1`
with `auto_stop_machines = 'off'`, and a `GET /health` check every 15s with a 30s
grace period.

Three of those differ deliberately from what the retired proxy used:

- **Never scales to zero** — the background goroutine refreshes the GTFS-RT feeds
  every 30s, so a stopped machine serves stale data.
- **30s health-check grace period** — `main()` downloads and unzips the 5.6 MB GTFS
  static ZIP before it starts listening, so a 5s grace would kill the machine at boot.
- **512 MB** — measured peak RSS is ~51 MB; the headroom is cheap insurance against an
  OOM restart, which would dump the cache and re-download the ZIP.

Always deploy with `--ha=false`. The cache is in-process, so a second machine would
poll MTA independently and serve inconsistent data depending on which one a request
lands on.

### GitHub Secrets Required

| Secret | Phase | Source |
|---|---|---|
| `FLY_API_TOKEN` | 5+ | `fly tokens create org <slug>` — org-scoped, so it can deploy `nyc-subway-api` |

The `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` secrets are no longer used;
Vercel's Git integration authenticates itself. They can be deleted from the repository.
| `GCP_SERVICE_ACCOUNT_KEY` | 5+ | GCP IAM → Service Accounts → JSON key |
| `FIREBASE_SERVICE_ACCOUNT` | 8+ | Firebase Console → Project Settings → Service Accounts |

---

## 23. Out of Scope

These features are intentionally excluded from all current phases:

| Feature | Reason excluded |
|---|---|
| Ticket purchasing / OMNY integration | Requires MTA partnership; not buildable independently |
| Bus routing | Separate MTA Bus Time API with different data shape; dilutes subway focus |
| Native iOS / Android app | PWA (Phase 6) covers installability; native app adds App Store overhead without new capability |
| LIRR / Metro-North | Different GTFS feeds, different fare structure, different rider problems |
| Turn-by-turn walking directions | Google Maps / Apple Maps API dependency; not core to the transit problem |
| Real-time crowding data via computer vision | Requires hardware access to MTA cameras; not publicly available |
| Paid subscription model | Not relevant to portfolio project goals |
