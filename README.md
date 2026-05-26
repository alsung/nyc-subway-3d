# NYC Subway 3D — Product Design Document

**Version:** 1.0  
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
11. [Phase 4 — Trip Planner + Car Positioning](#11-phase-4--trip-planner--car-positioning)
12. [Phase 5 — Commute Intelligence + Accessibility](#12-phase-5--commute-intelligence--accessibility)
13. [Phase 6 — Delay Heat Map + Weekend Mode](#13-phase-6--delay-heat-map--weekend-mode)
14. [Phase 7 — Crowd Avoidance + Cross-Modal Planning](#14-phase-7--crowd-avoidance--cross-modal-planning)
15. [Data Sources](#15-data-sources)
16. [API Reference](#16-api-reference)
17. [Test Strategy](#17-test-strategy)
18. [Deployment](#18-deployment)
19. [Out of Scope](#19-out-of-scope)

---

## 1. Product Summary

NYC Subway 3D is a browser-based, real-time visualization of the New York City subway system. It renders all 27 lines, 472 stations, and active train positions on a geographically accurate 3D map built with Three.js. The map is the primary interface — not a supplementary view bolted onto a list-based app.

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
A visitor from abroad opens the URL on their phone. They see the whole system in 3D and immediately understand the geographic relationship between Manhattan, Brooklyn, and Queens. They click Times Square. The popup shows 8 lines, next arrivals for each, and the exits at street level.

### UC-3: Rider encountering a service disruption
A signal failure is issued on the A/C/E at Jay St. The user sees affected line segments pulse red on the 3D map. Their saved commute (Fulton St → 72nd St) shows a disrupted route and an alternate via the 2/3. They reroute before leaving the building.

### UC-4: Wheelchair user planning a trip
A rider who uses a wheelchair needs elevator-only navigation. They enable accessibility mode. The map dims all stations without working elevators. Their route is recalculated to avoid the inaccessible 14th St–Union Square (elevator broken) and route via 23rd St instead.

### UC-5: Late night rider on a weekend
It's 1am on Saturday. The user looks at the map and immediately sees that F/G service has been rerouted, the A is running local instead of express, and the L is not running at all. Visual diffs on the map show exactly which stops are being skipped and where shuttle buses replace service.

### UC-6: Developer or engineer exploring the codebase
A backend engineer looks at the GitHub repo to understand how the GTFS-RT protobuf pipeline is built, how the Go proxy handles concurrent feed fetches with TTL caching, how the geo projection math works, and how the test suite is structured. The code is their product showcase.

---

## 5. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser (Vite + Three.js + Vanilla JS ES Modules)                      │
│                                                                          │
│  src/core/          src/scene/         src/ui/                           │
│  gtfs-parser.js     renderer.js        camera.js                         │
│  gtfs-loader.js     lines.js           filter.js                         │
│  geo.js             stations.js        popup.js                          │
│  color.js           trains.js          search.js                         │
│  router.js (P4)     trip-layer.js(P4)  trip-panel.js(P4)                 │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ fetch (CORS-proxied)
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Go Proxy  (Fly.io — ewr region)                                         │
│                                                                           │
│  proxy/main.go                                                            │
│  - Domain allowlist (api-endpoint.mta.info only)                         │
│  - In-memory TTL cache (30s per feed)                                    │
│  - sync.RWMutex for concurrent goroutine safety                          │
│  - /health endpoint for Fly.io health checks                             │
│  - Structured JSON logging via log/slog                                  │
│  - Graceful shutdown on SIGTERM                                           │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ no API key required
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  MTA Public Feeds                                                         │
│                                                                           │
│  GTFS Static ZIP     → stops.txt, routes.txt, shapes.txt, trips.txt      │
│  GTFS-RT (8 feeds)   → TripUpdate, VehiclePosition (protobuf binary)     │
│  Elevator/Escalator  → live outage data (Phase 5)                        │
│  Service Alerts      → camsys/subway-alerts (protobuf binary)            │
└──────────────────────────────────────────────────────────────────────────┘

Static hosting: Vercel (CDN edge, Vite dist/)
CI/CD:          GitHub Actions (test → build → deploy frontend + proxy)
```

---

## 6. Technology Stack

| Technology | Layer | Use case |
|---|---|---|
| Three.js r165 | Frontend / rendering | 3D scene graph, WebGL renderer, TubeGeometry for lines, raycasting for click detection |
| CatmullRomCurve3 | Frontend / rendering | Smooth spline interpolation along GTFS shape waypoints; `getPoint(t)` for train position interpolation |
| Vite 5 | Build | Dev server with HMR, production bundler via Rollup, tree-shakes Three.js |
| Vanilla JS (ES modules) | Frontend | All app logic as native ES modules; no framework overhead on a WebGL canvas |
| Vitest | Testing | Unit test runner for all `src/core/` modules; runs in Node, no DOM or browser needed |
| Go 1.22 | Backend / proxy | HTTP server for CORS proxy; net/http stdlib only, no frameworks |
| log/slog | Backend | Structured JSON logging for each proxied request |
| sync.RWMutex | Backend | Thread-safe in-memory feed cache; concurrent reads, serialized writes |
| net/http/httptest | Backend testing | In-memory request/response testing for proxy handlers without binding a port |
| MTA GTFS static | Data | `stops.txt` → stations, `routes.txt` → colors, `shapes.txt` → route geometry, `trips.txt` → shape-to-route mapping |
| MTA GTFS-RT | Data | 8 protobuf binary feeds updated every ~30s; `TripUpdate` for arrival times, `VehiclePosition` for train locations |
| Vercel | Infrastructure | Static frontend hosting; global CDN, automatic deploys from GitHub Actions |
| Fly.io | Infrastructure | Go proxy containerized app in `ewr` (Newark) region; scales to zero, health-checked |
| GitHub Actions | CI/CD | 5-job pipeline: JS tests → build → deploy frontend → Go tests → deploy proxy |

---

## 7. Phase Roadmap

| Phase | Name | Status | Key deliverable |
|---|---|---|---|
| 1 | Static 3D map | Complete | All lines + stations rendered from GTFS data, 2D/3D toggle, station search, line filter |
| 2 | Live arrivals | In progress | Real protobuf decoding, next 5 arrivals per station from GTFS-RT |
| 3 | Live train positions | Planned | Real vehicle positions from GTFS-RT, interpolated between stops |
| 4 | Trip planner + car positioning | Planned | Origin → destination routing, highlighted route on map, optimal car recommendation |
| 5 | Commute intelligence + accessibility | Planned | Saved commutes, elevator-only routing, live outage data |
| 6 | Delay heat map + weekend mode | Planned | Per-line delay scoring, visual service change diff on weekends |
| 7 | Crowd avoidance + cross-modal | Planned | Historical ridership by car, CitiBike + NYC Ferry integration |

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
│   ├── ci.yml           # test + build on every PR
│   └── deploy.yml       # deploy to Vercel + Fly on main push
├── proxy/
│   ├── main.go
│   ├── main_test.go
│   ├── go.mod
│   └── fly.toml
├── public/
│   └── gtfs/            # place MTA GTFS files here (gitignored)
│       ├── stops.txt
│       ├── routes.txt
│       ├── shapes.txt
│       └── trips.txt
├── src/
│   ├── styles.css
│   ├── main.js          # entry point, wires all modules together
│   ├── core/            # pure logic — no DOM, no Three.js, fully testable
│   │   ├── geo.js           # lat/lng ↔ XZ projection, haversine, downsample
│   │   ├── gtfs-parser.js   # CSV parser + GTFS file parsers
│   │   ├── gtfs-loader.js   # fetch GTFS files or fall back to embedded
│   │   └── color.js         # contrast color, hexToRGB
│   ├── data/
│   │   └── embedded.js      # fallback station/route constants
│   ├── scene/           # Three.js only — no business logic
│   │   ├── renderer.js      # scene, camera, renderer factory functions
│   │   ├── lines.js         # TubeGeometry per route
│   │   ├── stations.js      # CylinderGeometry per station
│   │   └── trains.js        # simulated train meshes + tick()
│   └── ui/              # DOM manipulation only
│       ├── camera.js        # orbit controls, tween, setView()
│       ├── filter.js        # line chip toggles
│       ├── popup.js         # station info popup
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
`TubeGeometry` arguments: curve, tubular segments, radius (0.11), radial segments (5), closed (false).

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

#### Go proxy (`proxy/main_test.go`)
| Test | Assertion |
|---|---|
| `isAllowed` permits MTA domains | `api-endpoint.mta.info` → true |
| `isAllowed` permits MTA S3 | `rrgtfsfeeds.s3.amazonaws.com` → true |
| `isAllowed` blocks arbitrary domains | `evil.com` → false |
| `isAllowed` blocks malformed URLs | `not-a-url` → false |
| Cache hit returns stored body | Pre-seeded entry returned with `X-Cache: HIT` |
| Cache miss on unknown key | `get("nonexistent")` → false |
| Cache expiry | Entry with `fetchedAt` 2× TTL ago → miss |
| Cache overwrite | Second `set` on same key returns new value |
| `/health` returns 200 + JSON | Status and Content-Type correct |
| Missing URL → 400 | `/proxy` with no `?url=` returns Bad Request |
| Blocked URL → 403 | `evil.com` URL returns Forbidden |
| POST method → 405 | Non-GET returns Method Not Allowed |
| OPTIONS → 204 + CORS header | Preflight returns No Content + `Access-Control-Allow-Origin: *` |

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
- Interpolate position between GTFS-RT updates using scheduled stop times
- Orient train mesh along track tangent
- Switch from individual `BoxGeometry` meshes to `InstancedMesh` for performance
- Display train count in stats bar

### Key Implementation Notes

#### Position interpolation
GTFS-RT `VehiclePosition` updates arrive every 30–60s. Between updates, position is interpolated using the `TripUpdate` stop time sequence:

```
progress = (now - departureTime[lastStop]) / (arrivalTime[nextStop] - departureTime[lastStop])
t = lerp(curveT[lastStop], curveT[nextStop], progress)
position = curve.getPoint(clamp(t, 0, 1))
```

Each stop in the GTFS static schedule corresponds to a `t` value along the route curve, pre-computed when the curve is built.

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

## 11. Phase 4 — Trip Planner + Car Positioning

### Goal
The central feature. User inputs origin and destination station. The app finds the optimal route using graph traversal over the GTFS station network, highlights the route on the 3D map, and recommends which car to board based on exit position at the destination.

### Scope
- Build station graph from GTFS data (nodes = stations, edges = consecutive stops on a route)
- Implement BFS/Dijkstra on the graph weighted by travel time + transfer penalty
- Highlight route segments on the 3D map (selected lines brighten, others dim)
- Fly camera to frame the route
- Show turn-by-turn panel: line, direction, stops, transfer instructions
- Recommend front/middle/back of train based on destination exit
- Car positioning data stored as static JSON: `{ [stopId + direction]: { optimal_car, exit_name, notes } }`

### Key Implementation Notes

#### Station graph construction
```
Graph G = (V, E)
V = all parent stations from stops.txt
E = (station_a, station_b, route_id, travel_time_seconds)
    for each consecutive pair in stop_times.txt
```

Transfer edges connect the same physical station served by multiple routes:
```
E_transfer = (station_x_line_A, station_x_line_B, null, TRANSFER_PENALTY_SECONDS)
TRANSFER_PENALTY_SECONDS = 120   // 2 minutes, tunable
```

#### BFS for unweighted / Dijkstra for time-weighted
For MVP: BFS minimizes transfers (fewest changes). For improvement: Dijkstra with `travel_time` as edge weight minimizes total journey time.

```js
// Dijkstra sketch
function findRoute(graph, originId, destId) {
  const dist = new Map()    // stopId → best seconds
  const prev = new Map()    // stopId → { from, routeId }
  const pq = new MinPriorityQueue()
  pq.enqueue({ id: originId, cost: 0 })
  // ... standard Dijkstra expansion
  return reconstructPath(prev, destId)
}
```

#### Car positioning data (`src/data/car-positions.json`)
```json
{
  "127S_downtown": {
    "optimal_car": "front",
    "car_number": "1-2",
    "exit": "42 St / 8 Ave exit",
    "notes": "Board front 2 cars for direct access to A/C/E mezzanine"
  },
  "635S_downtown": {
    "optimal_car": "back",
    "car_number": "last 2",
    "exit": "Wall St / Broadway staircase",
    "notes": "Rear cars align with uptown staircase at Bowling Green"
  }
}
```

Data sourced from Exit Strategy NYC documentation and MTA station layout diagrams. Keyed by `stopId + direction`.

#### Route highlighting
When a route is selected:
1. All non-route line tubes: `material.opacity → 0.1`, `emissiveIntensity → 0.05`
2. Route segments: `material.opacity → 1.0`, `emissiveIntensity → 0.8`, color stays as line color
3. Camera tweens to a position that frames the bounding box of all route stations
4. Station meshes on the route pulse gently

### Test Cases — Phase 4

| Test | Type | Assertion |
|---|---|---|
| Graph has correct node count | Unit | `graph.nodes.size === stations.length` |
| Graph edges are bidirectional | Unit | Edge A→B implies edge B→A |
| BFS finds path between adjacent stations | Unit | Single-hop route correctly resolved |
| BFS finds path requiring one transfer | Unit | Route uses transfer edge when direct line unavailable |
| Dijkstra prefers faster route over fewer transfers | Unit | 20-min direct beats 15-min + 10-min with transfer |
| Car position lookup returns correct car | Unit | `stopId + direction` key resolves to expected `optimal_car` |
| Route with no path returns null | Unit | Disconnected stations → `findRoute()` returns `null` |
| Camera bounding box frames all route stations | Unit | All station positions within frustum after tween |

---

## 12. Phase 5 — Commute Intelligence + Accessibility

### Goal
Personalized features: save your regular commute, see how reliable it is by time of day, and route around broken elevators with live outage data.

### Scope
- Save up to 3 commute pairs to `localStorage` (no auth required)
- For each saved commute, show: average on-time rate by hour, best time to leave, next departure from origin
- Elevator/escalator outage data from MTA Elevator & Escalator Status API
- Accessibility routing mode: only route through stations with working elevators
- Visual indicator on map: inaccessible stations dimmed, broken elevators shown as orange markers

### Key Implementation Notes

#### Elevator outage API
```
GET https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-elevator-escalator
```
Returns GTFS-RT `Alert` entities where `informed_entity.stop_id` identifies the affected station. Polled every 5 minutes (outages don't change at GTFS-RT cadence).

#### Accessibility routing
Before building the route graph, filter out stations with known elevator outages on the required direction of travel. Re-run Dijkstra on the filtered graph. If no accessible route exists, surface a message explaining the gap and show the closest accessible alternative.

#### On-time scoring
The MTA publishes historical on-time performance data via NY State Open Data. Pre-compute a per-line, per-hour, per-direction delay probability matrix. Store as a compressed JSON blob (~50KB). At trip plan time, look up the probability of a delay on the user's route at their planned departure time.

### Test Cases — Phase 5

| Test | Type | Assertion |
|---|---|---|
| Saved commutes persist across page reload | Integration | `localStorage.getItem('commutes')` populated after save |
| Maximum 3 saved commutes enforced | Unit | 4th save replaces oldest |
| Accessibility filter removes outage stations | Unit | Graph excludes station when elevator outage present |
| Accessible route found even when direct route inaccessible | Unit | Longer path returned when shortest path blocked |
| No accessible route surfaces correct message | Unit | `null` route → specific error message (not generic) |
| Elevator outage poll interval is 5 minutes | Unit | `setInterval` called with `300_000` |

---

## 13. Phase 6 — Delay Heat Map + Weekend Mode

### Goal
Make the overall health of the system visible spatially. Color-code lines by their current delay severity. On weekends, show the service restructuring visually on the map instead of in a text alert.

### Scope
- Per-line delay score: computed from `TripUpdate` deviation vs scheduled arrival times
- Color each line segment by delay severity: green (on time), amber (minor), red (major)
- Weekend mode: auto-detect when service changes are active; dim affected segments and show alternate routing
- Supplemented GTFS feed parsing for planned service changes (updated hourly)

### Key Implementation Notes

#### Delay score computation
For each active trip in the `TripUpdate` feed:
```
scheduled_arrival = stops.txt stop time for this stop_id
actual_arrival    = TripUpdate.stop_time_update.arrival.time
delay_seconds     = actual_arrival - scheduled_arrival
```
Aggregate per route: rolling average over last N trips. Score:
- `0–60s` → green
- `60–180s` → amber
- `>180s` → red

#### Weekend service diff
The MTA supplemented GTFS is updated hourly and includes service changes for the next 7 days. When a trip's `shape_id` differs from the canonical weekday shape, the affected stops are visually flagged on the map. Line segments that are suspended render as dashed tubes rather than solid.

### Test Cases — Phase 6

| Test | Type | Assertion |
|---|---|---|
| Delay score 0–60s maps to green | Unit | Score < 60 → `'on-time'` status |
| Delay score >180s maps to red | Unit | Score > 180 → `'major-delay'` status |
| Rolling average drops oldest entries | Unit | Window capped at N trips |
| Weekend mode activates on Saturday/Sunday | Unit | `isWeekend(date)` returns true Sat/Sun |
| Suspended segment renders as dashed | Unit | Segment material `dashed: true` when no service |

---

## 14. Phase 7 — Crowd Avoidance + Cross-Modal Planning

### Goal
Tell riders which car is least crowded on their specific train, and plan routes that incorporate CitiBike and NYC Ferry as last-mile options.

### Scope
- Historical ridership by car and time of day (MTA publishes this; sourced from open data)
- Crowd estimate at trip plan time: "car 3 is typically 30% less crowded at 8:45am on this line"
- NYC Ferry GTFS integration: ferry stops added to routing graph as nodes with walk-time transfer edges
- CitiBike station availability via CitiBike GBFS feed; show dock availability near destination station

### Key Implementation Notes

#### Crowd data
MTA publishes ridership by car via NY Open Data. Pre-process into a lookup:
```json
{ "F_eastbound_8am": { "car1": 0.9, "car2": 0.7, "car3": 0.4, ... } }
```
Where values are relative load factors (1.0 = typical peak). At trip plan time, surface the least-loaded car for the user's departure hour.

#### Cross-modal graph extension
Add ferry terminal nodes and CitiBike nodes to the routing graph. Ferry edges have exact schedule-based weights. CitiBike edges have a configurable walk-time estimate. The trip planner treats them as valid transfers and can return a route like:
```
Take the A to Jay St → walk 0.3mi → CitiBike to destination
```

### Test Cases — Phase 7

| Test | Type | Assertion |
|---|---|---|
| Crowd lookup returns least-loaded car | Unit | `minBy(carLoads, v => v)` returns correct car key |
| Ferry nodes connect to nearest subway stations | Unit | Walk edge created for ferry within 0.5km of subway |
| CitiBike docks with 0 bikes excluded | Unit | Empty dock not offered as origin |
| Cross-modal route includes walk segment | Unit | Returned path contains edge with `type: 'walk'` |

---

## 15. Data Sources

| Source | URL | Format | Update frequency | Auth required |
|---|---|---|---|---|
| GTFS Static (subway) | `https://rrgtfsfeeds.s3.amazonaws.com/gtfssubway.zip` | ZIP (CSV files) | A few times per year | None |
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

## 16. API Reference

### Go Proxy

All requests go to the proxy. The proxy adds CORS headers and caches responses.

```
GET /proxy?url=<encoded-mta-feed-url>
GET /proxy/<url-encoded-path>
GET /health

Response headers:
  X-Cache: HIT | MISS
  Content-Type: application/x-protobuf
  Access-Control-Allow-Origin: *
```

The proxy only forwards to `api-endpoint.mta.info` and `rrgtfsfeeds.s3.amazonaws.com`. All other target URLs return 403.

### Frontend Modules (public API surface)

```js
// src/core/geo.js
geoToXZ(lat, lng) → { x, z }
xzToGeo(x, z)    → { lat, lng }
haversineKm(a, b) → number
downsample(points, maxPoints) → points[]

// src/core/gtfs-parser.js
parseCSV(text)    → Object[]
parseRoutes(text) → { [routeId]: RouteInfo }
parseStops(text)  → { stations: Station[], childToParent: {} }
parseShapes(text) → { [shapeId]: ShapePoint[] }
parseTripsToRouteShapes(text, shapes) → { [routeId]: [lat,lng][] }
parseGTFS(stops, routes, shapes, trips) → GTFSData

// src/core/color.js
contrastColor(hex) → '#000' | '#fff'
hexToRGB(hex)      → { r, g, b }
```

---

## 17. Test Strategy

### Principles
- **Only `src/core/` is unit-tested.** Scene and UI code depends on Three.js and the DOM — both require a browser to run meaningfully. Tests live in `tests/unit/` and run in Node via Vitest with zero DOM setup.
- **Go proxy is fully unit-tested** using `net/http/httptest`. No live network calls in tests.
- **Integration tests** (Phase 2+) use fixture protobuf binaries checked into `tests/fixtures/` — real snapshots of MTA feeds captured at a point in time.
- **No mocks for core logic.** Functions in `src/core/` take plain data in and return plain data out. Mocking is never needed.

### Running tests
```bash
# JavaScript unit tests
npm test                    # run once
npm run test:watch          # watch mode
npm run test:coverage       # with V8 coverage report

# Go proxy tests
cd proxy && go test ./...
cd proxy && go test ./... -v   # verbose
cd proxy && go test ./... -race  # race detector

# CI (runs automatically on every push and PR)
# See .github/workflows/ci.yml
```

### Coverage targets
| Module | Target |
|---|---|
| `src/core/geo.js` | 100% |
| `src/core/gtfs-parser.js` | 100% |
| `src/core/color.js` | 100% |
| `proxy/main.go` (handler logic) | >90% |
| `src/core/router.js` (Phase 4) | 100% |

Scene and UI modules are excluded from coverage requirements — they are tested manually and via visual inspection.

---

## 18. Deployment

### Frontend (Vercel)

```bash
# One-time setup
npm i -g vercel
vercel link   # creates .vercel/project.json

# Manual deploy
npm run build
vercel deploy --prod

# Automatic: push to main triggers GitHub Actions → deploy.yml
```

`vercel.json` configures:
- Build command: `npm run build`
- Output directory: `dist/`
- SPA rewrite: all routes → `index.html`
- Asset cache headers: `Cache-Control: public, max-age=31536000, immutable` for hashed chunks

### Proxy (Fly.io)

```bash
# One-time setup
curl -L https://fly.io/install.sh | sh
fly auth login
fly apps create nyc-subway-proxy --config proxy/fly.toml

# Manual deploy
fly deploy --config proxy/fly.toml

# Automatic: push to main triggers GitHub Actions → deploy.yml
```

`proxy/fly.toml` configures:
- Region: `ewr` (Newark, closest to MTA servers)
- Memory: 256MB
- Auto-stop when idle (free tier compatible)
- Health check: `GET /health` every 15s

### GitHub Secrets Required

| Secret | Source |
|---|---|
| `FLY_API_TOKEN` | `fly tokens create deploy` |
| `VERCEL_TOKEN` | vercel.com → Account → Tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` after `vercel link` |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` after `vercel link` |

### Environment Configuration

Set `PROXY` in `src/core/gtfs-loader.js`:
```js
const PROXY = 'https://nyc-subway-proxy.fly.dev'  // production
// const PROXY = 'http://localhost:8080'           // local dev
```

---

## 19. Out of Scope

These features are intentionally excluded from all current phases:

| Feature | Reason excluded |
|---|---|
| Ticket purchasing / OMNY integration | Requires MTA partnership; not buildable independently |
| Bus routing | Separate MTA Bus Time API with different data shape; dilutes subway focus |
| User accounts / authentication | No persistent server-side state; `localStorage` is sufficient for MVP |
| Native iOS / Android app | Progressive web app only; avoids App Store review cycle |
| LIRR / Metro-North | Different GTFS feeds, different fare structure, different rider problems |
| Turn-by-turn walking directions | Google Maps / Apple Maps API dependency; not core to the transit problem |
| Real-time crowding data via computer vision | Requires hardware access to MTA cameras; not publicly available |
| Paid subscription model | Not relevant to portfolio project goals |