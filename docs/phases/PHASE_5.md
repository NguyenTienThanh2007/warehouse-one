# Phase 5 — Multi-site logistics world (first vertical slice)

**Branch:** `feature/p5-multi-site-world` · **Base:** `main` @ `0b25fa4` (Phase 3 merged, PR #5)
**Status:** IN REVIEW (pull request to `main`; not merged). Results below were measured on this
branch; CI results are recorded in §7 once the pull request has run.

## 1. Starting point (verified 2026-10-21)

| Check | Result |
|-------|--------|
| `main` | `0b25fa4`: Phases 0–3 merged (PR #1–#5); PR #6 (Phase 4 planning docs) was closed unmerged |
| Working tree | Clean on `main` before branching; no stashes |
| World | One warehouse (the showcase DC) on a paved yard, surrounded by empty ground |
| Engine | Deterministic `step()`; the DC's operations (`state.ops`): pallets, MHE, tasks, docks, trucks, orders |
| Contracts | 13 event types, 7 commands; Pydantic mirror and dbt silver accept exactly those |

Phase numbering: the owner asked for this work as "Phase 5 — multi-site world". The roadmap's
analytics phase (4) has not been implemented; AI and digital-twin work moves after this phase
(`docs/ROADMAP.md`).

## 2. What was built

### 2.1 The world (what you see)

One connected logistics park around the existing DC, drawn from layout data in the scenario config:

| Area | Contents | Live from state |
|------|----------|-----------------|
| **Northgate distribution centre** | The Phase 1–2 DC unchanged (racks, docks, forklifts, yard), plus a **truck marshalling yard** (6 staging stalls) and the exit apron onto the avenue | Everything in the DC as before; stall occupancy |
| **Harbour container terminal** | Quay and water, 2 ship-to-shore cranes, 5 container stack blocks with rubber-tyred gantries, a container freight station (CFS) with 4 loading doors, 4 staging stalls, gatehouse | Containers stacked = terminal container count; pallets in the CFS staging lanes = terminal stock; door lights |
| **Riverside cross-dock** | 70 × 24 m hall with 6 inbound doors (south) and 6 dispatch doors (north), ring road, 4 staging stalls, dispatch office | Pallets in the door lanes = stock; door lights; trucks at doors |
| **Fleet depot & workshop** | 6 home stalls, maintenance workshop with 2 drive-in service bays, fleet office | Trucks parked / in service |
| **East highway gateway** | Sign gantry; the highway continues out of the modelled world | Trucks leaving for last-mile runs and coming back |
| **Roads** | Arterial avenue along the south, a north link road behind the DC, site lanes and connectors; lane and edge markings, street lights, landscaping | Line-haul trucks driving on them (keep right) |

Buildings with an interior (cross-dock, CFS, workshop) are cut away in their facility view: the
roof hides and the walls facing the camera drop to a knee wall, as the DC does.

### 2.2 Simulation (what drives it)

The network is part of the deterministic engine, not an animation layer (`packages/simulation/src/network/`):

- **Config** (`config.network`, optional): sites with stable ids and kinds, stands (doors, staging
  stalls, home parking, service bays) with their approach road nodes, buildings, a road graph,
  line-haul trucks, and transfer lanes. Single-site configs have no `network`; their state shape,
  events and hashes are unchanged (golden fixtures byte-identical).
- **State** (`state.network`): per-site stock by SKU, allocations, incoming capacity, containers,
  devanning, stand reservations and counters; line-haul trucks (node, route, progress in mm,
  stand, intent, cargo, odometer); active transfers.
- **Transfers:** planned by seeded lanes or by the operator (`transfer.request`); stock is
  allocated at the origin and capacity reserved at the destination, then
  `planned → assigned → loading → in_transit → unloading → delivered` (gateway transfers skip
  unloading: the pallets leave the modelled world).
- **Trucks:** the nearest idle truck is assigned (road distance, then id). A truck reserves a stand
  at its destination before it leaves (a door, else a staging stall), so it never arrives
  without a place to stand. Driving is integer-millimetre progress along shortest roads
  (Dijkstra, ties by node id) at 40 km/h on arterials and 20 km/h on site lanes, keeping a 24 m
  headway behind trucks going the same way. Docking, handling (one pallet per
  `handling_ticks_per_pallet`) and pulling out take real ticks.
- **DC hand-over:** at the DC gate the network issues an ordinary `order.create` (DC is the
  origin) or `truck.schedule_inbound` (DC is the destination) through the DC's own command
  handlers, so every DC rule applies (yard slots, storage capacity, available stock). The DC
  truck is held in its yard slot for 90 ticks while the line-haul truck reverses in, then the DC
  simulation docks, unloads or picks and loads it. When it departs the network takes the truck
  back. Not admitted (yard full, no storage), the truck waits on a marshalling stall and retries.
  An order serving a line-haul truck cannot be cancelled on its own.
- **Terminal:** vessels discharge containers on a seeded schedule; while the CFS holds fewer than
  60 pallets one container at a time is devanned into 12 pallets of one SKU.
- **Fleet:** after 5 km a truck is serviced at a free workshop bay (90 s); idle trucks return to
  their home stall.
- **Events:** `transfer.status_changed`, `linehaul.status_changed`, `site.stock_changed` (all
  `schema_version` 1). The operator command `transfer.request` is validated like every other
  command and rejected with `UNKNOWN_SITE`, `INVALID_TRANSFER`, `INSUFFICIENT_STOCK`,
  `NO_CAPACITY` or `NETWORK_DISABLED`.
- **Invariants** (checked with the core invariants and on snapshot load): non-negative integer
  stock, allocations within stock, capacity including incoming, trailer capacity, stand
  reservations consistent with truck positions, transfers and trucks referencing each other,
  trucks at the DC backed by a DC truck.

### 2.3 Interaction

- Opens on the **world view** (camera "World", key `W`); the **site navigator** (World + one
  button per site) and **site labels** with a live figure fly the camera into a site's
  **facility view** and back. The current view is highlighted and drives which panel shows: the
  DC's operations panel in the DC, the **network panel** (transfers, fleet) elsewhere.
- Click a site (ground or label) to inspect it: stock by SKU, containers and devanning, doors and
  stalls in use, trucks on site, transfers in and out, received/dispatched counters, and a form
  that submits `transfer.request`. Click a line-haul truck (or a fleet row) to inspect status,
  location, transfer, cargo, handling progress, its DC truck while inside the DC, odometer and
  distance since service. Double-click flies to it.
- Pause, resume, step, speed (0.5×–8×), reset, scenarios and recording work as before.
  `?scenario=showcase` (or the scenario picker) opens the single-site DC exactly as in Phase 2.

### 2.4 Rendering

- Static network geometry is built once per config and merged per material
  (`world/network-geometry.ts`): ~50 draw calls for all roads, sites, buildings, cranes and trees.
  Build time < 0.1 s; the triangle budget for the network is tested (< 250 k).
- Containers and floor pallets are instanced with fixed capacity (no reallocation as stock
  changes); trucks are instanced and written every frame from `linehaulPose`, interpolated.
- The sun's shadow frustum follows the camera target and scales with distance (sharp in a
  facility, wide in the world view), snapped to the shadow-map texel grid.
- Site labels are DOM elements positioned each frame by projection (beneath the HUD panels).

## 3. Rules and timings

| Rule | Value |
|------|-------|
| Speeds | 1,100 mm/tick (arterial, 39.6 km/h), 550 mm/tick (site lanes) |
| Headway | 24 m behind a truck on the same road segment and direction |
| Docking / pulling out | 70 / 50 ticks; DC arrival hold 90 ticks, DC exit 50 ticks |
| Handling | 25 ticks per pallet (terminal), 20 (cross-dock) |
| Retry while waiting | every 50 ticks; a DC-origin transfer waiting 6,000 ticks is cancelled |
| Service | after 5 km, 900 ticks in a workshop bay |
| Last-mile run | 1,800 ticks outside the world after the gateway |
| Lanes (network scenario) | terminal → XD every 900 ticks (10–18 pallets); XD → gateway every 1,200 (6–12); XD → DC and DC → XD every 3,600 (2–4, the showcase's DC volume); terminal → DC every 7,200 (2–4) |
| Terminal | 150 of 360 containers at start; vessel every 9,000 ticks (18–30); devan 12 pallets in 300 ticks while stock < 60 |

## 4. Verification on this branch (Apple M2, macOS)

| Check | Command | Result |
|-------|---------|--------|
| Format, lint, typecheck, unit tests, build | `pnpm check` | PASS: contracts 26, simulation 154, recorder 10, web 72; build OK |
| Network engine tests | `network/network.test.ts`, `network-golden.test.ts` | PASS: 22 + 7 |
| Golden fixtures | foundation-demo, operations-demo | Byte-identical (no diff); new `network-demo` fixture (737 events) |
| Python contract tests | `cd apps/api && uv run pytest -m "not integration"` | PASS: 45 (network fixture through JSON Schema and Pydantic) |
| Python lint/types | `uv run ruff check . && uv run ruff format --check . && uv run mypy` | PASS |
| Browser E2E, real GPU | `pnpm --filter @warehouse-one/web build && pnpm test:e2e` | PASS: 28 passed, 1 skipped (`recording.spec.ts` needs `RECORDING_API_URL`) |
| Browser E2E, CI mode (SwiftShader) | `CI=1 pnpm test:e2e` | PASS: 28 passed, 1 skipped, 1 flaky in 11.8 min (run before two network tests were merged into one). The flaky test (console errors) failed once on a CORS error from an unrelated API container on local port 8000, then passed; CI has no API on that port |
| Postgres / Kafka / S3 integration tests | CI only | NOT RUN locally (the owner's Compose stack occupies the ports); run by CI on the pull request |

Rendering benchmark (`pnpm bench:render`, production build, headless Chromium, Apple M2 Metal,
1440 × 900 at DPR 2):

| Scene | FPS | p50 ms | p95 ms | Draw calls | Triangles |
|-------|-----|--------|--------|------------|-----------|
| showcase · high (single site, unchanged) | 60.0 | 16.7 | 20.0 | 122 | 487 k |
| network world · high | 57.7 | 17.2 | 18.6 | 214 | 689 k |
| network world · low | 60.0 | 16.7 | 18.3 | 108 | 349 k |

Under SwiftShader (CI's software WebGL, Low tier) the world view renders at p50 281 ms per frame
against 265 ms for the single-site showcase; the browser CI job's timeout was raised from 20 to 35
minutes because main already used 14m41s of it (`.github/workflows/ci.yml`).

Engine checks in `network.test.ts` over a 24,000-tick run: invariants every 250 ticks; pallet
conservation (site stock + trailers + DC pallets = start + devanned − delivered to the gateway);
pose continuity (no jump > 4.5 m between ticks while drawn by the network); hand-over to and from
the DC within 1.5 m; headway never violated; transfer lifecycle order on every lane; contract
validity and gap-free sequence of every event; determinism and replay; snapshot round trip.

## 5. How to run and look at it

```bash
pnpm install
pnpm dev                                   # http://localhost:3000 opens on the world view
pnpm --filter @warehouse-one/web build && pnpm --filter @warehouse-one/web exec next start -p 3100
pnpm capture:network                       # screenshots: world + every site → docs/phases/evidence/phase-5
```

Keys: `W` world, `O` DC overview, `D` docks, `A` aisle, `T` plan, `F` focus, `Space` pause,
`1`–`5` speed. `?scenario=showcase` opens the single-site DC.

## 6. Limitations (honest)

- **Sites other than the DC are aggregate models.** The terminal, cross-dock and depot keep pallet
  counts per SKU, not individual pallets, and have no forklifts or workers; their doors handle
  one pallet per fixed interval. Pallets on their floors are laid out for display from the count.
- **No cross-site orders or inventory policy.** Lanes are seeded schedules, not demand-driven;
  there is no routing optimisation (nearest idle truck, shortest path).
- **Traffic is simplified.** Trucks keep a headway on a segment but junctions have no right of
  way, so two trucks can briefly overlap when crossing; lane offsets change at corners.
- **Static infrastructure** (cranes, gantry sign, lights, trees) is not simulated; the container
  stacks and floor pallets are.
- **Off-map last mile** is a fixed delay, not a model.
- Analytics models (dbt silver/gold) accept the new event types but do not yet model transfers or
  the fleet; Phase 4 analytics is still to be built.
- The world view's composition assumes a desktop; on phones the HUD covers more of it.

## 7. CI

To be recorded from the pull request's run.

## 8. Next increments

1. **Cross-site orders and inventory:** customer orders at the gateway pull from the cross-dock
   and the DC; replenishment lanes driven by stock levels instead of fixed schedules.
2. **Detailed second facility:** give the cross-dock its own pallets, forklifts and tasks by
   reusing the DC operations model per site (`state.ops` keyed by site).
3. **Traffic rules:** junction reservations and turning paths; yard spotters.
4. **Network analytics:** silver/gold models for transfers, dwell and fleet utilisation, reconciled
   with the event stream (Phase 4 scope).
5. **AI routing and digital-twin scenarios** on top of the transfer and fleet model.
