# Decision Log

Short architecture decision records. Status: **Accepted** unless noted. Newest at the bottom.

---

### DEC-001 — Monorepo with pnpm workspaces + a separate uv-managed Python project
**Context:** TypeScript (web, simulation, contracts) and Python (API, later data pipelines) must
share contracts and live in one repo. **Decision:** pnpm workspaces for TS packages (`apps/*`,
`packages/*`) with recursive scripts. `apps/api` is a standalone uv project with its own lockfile.
No Turborepo or Nx yet. **Consequences:** simple tooling with a fast install. Build caching is
revisited if CI time exceeds ~10 minutes.

### DEC-002 — Simulation is the operational source of truth and runs as pure TypeScript
**Decision:** `step(config, state, commands)` is pure and deterministic. The runner is the only
imperative shell, and renderers receive deep-frozen state. **Why:** replay, snapshot verification,
testability, and running the same engine in the browser, in Node (benchmarks, fixture generation)
and later in a worker or server. **Consequences:** every system must be written without ambient
time or randomness (enforced by lint).

### DEC-003 — Integer fixed tick (100 ms) and integer quantities
**Why:** floating-point time accumulation and fractional stock make determinism and reconciliation
fragile. **Consequences:** sub-tick motion in Phase 2 is interpolated in the renderer only.

### DEC-004 — Deterministic event IDs (UUID v8 from `simulation_id` + `sequence`)
**Alternatives:** random UUID v4/v7. **Why:** replays and redeliveries produce identical IDs, so
downstream deduplication by `event_id` is correct across replays. **Trade-off:** IDs encode no
wall-clock time, so ingestion time is a separate column.

### DEC-005 — Contracts authored in Zod, published as JSON Schema, mirrored in Pydantic
**Alternatives:** JSON Schema as the hand-written source, with code generated for both languages;
Protobuf/Avro now. **Why:** Zod gives the strongest TS ergonomics where most producers live. JSON
Schema is language-neutral for Python and the pipeline. Drift is caught by tests on both sides.
**Revisit:** Phase 3 may adopt a schema registry (Avro/JSON Schema) for Kafka. The committed
JSON Schemas are designed to seed it.

### DEC-006 — Event `occurred_at` is simulated business time; wall-clock is added downstream
**Why:** keeps the engine deterministic and makes analytical time meaningful (a simulated shift).
Ingestion and processing timestamps are added by the publisher and consumers for freshness metrics.

### DEC-007 — Create directories only when they hold real code
**Context:** the master brief proposes `packages/graphics`, `packages/ui`, `data/dbt`,
`infrastructure/` and others. **Decision:** they are created in the phase that fills them. Phase 0
deviations: the compose file lives at the repo root (one file, conventional location), and API
integration tests live in `apps/api/tests/integration`.

### DEC-008 — Tooling versions: TypeScript 6.0 and ESLint 9 (not the newest majors)
**Context (2026-10):** TypeScript 7.0 (native compiler) drops the classic compiler API, and
`typescript-eslint` 8.71 supports `<6.1`. `eslint-plugin-react` (via `eslint-config-next`) does not
support ESLint 10. **Decision:** pin TypeScript 6.0.3 and ESLint 9.39.5. Revisit when
typescript-eslint supports TS 7. All dependency pins were at least two weeks old at selection time.

### DEC-009 — Next.js app consumes workspace packages as TypeScript source
`transpilePackages` compiles `@warehouse-one/contracts` and `@warehouse-one/simulation` directly,
so there is no package build step and no stale `dist`. If the packages are ever published they get
a real build.

### DEC-010 — Phase 0 Docker stack is PostgreSQL + API only
**Why:** the brief requires introducing infrastructure when its responsibilities are real. The dev
machine also has a ~4 GB Docker memory budget. Kafka (KRaft), MinIO and Airflow arrive in Phase 3
with their consumers and tests.

### DEC-011 — State management: Zustand as a read-only projection
The store holds the runner privately and exposes a projection (tick, inventory reference, recent
events, hash) plus actions. Components subscribe with selectors. The fixed-step loop is driven by
its own `requestAnimationFrame`, independent of R3F's render loop.

### DEC-012 — Synthetic workload lives inside the engine as an optional system
It reuses command handlers, so invariants still hold, and is driven by the in-state RNG, so it is
deterministic and snapshot-safe. It is labelled as synthetic and disabled when the config omits it.
Phase 2 replaces it with real inbound/outbound processes.

### DEC-013 — `httpx2` for FastAPI's TestClient
Starlette 1.9 deprecates `httpx` in its TestClient in favour of `httpx2` (maintained by the
Pydantic organisation). It is used in tests only.

### DEC-014 — Facility master data lives in the simulation config (Phase 1)
**Context:** the 3D world needs a building, racking dimensions, docks and vehicles, which Phase 0
data did not contain. Letting the renderer make them up would break "rendering never invents
operational data". **Decision:** an optional `SimulationConfig.facility` (building, site, rack spec,
docks, equipment) plus `LocationConfig.yaw`. Neither affects simulation rules in Phase 1; both are
validated. **Consequences:** inspectors and renderers read one source; configs without facility data
get a plain building and no docks or vehicles. Phase 2 promotes equipment to stateful aggregates.

### DEC-015 — Beam-level placement is a display convention until per-pallet tracking
Inventory is tracked per bay (location × SKU quantity), not per beam position. The renderer assigns
units to slots deterministically (SKU order, bottom-up) and the inspector discloses this. Phase 2
adds pallet entities with exact slots, and the convention is retired.

### DEC-016 — High quality tier caps the device pixel ratio at 1.5
**Measured:** at DPR 2 on an Apple M2 (1440×900 @2x) the High tier ran at 42–44 FPS regardless of
scene size (fill-rate-bound: AO + shadows + SMAA at 5.2 MP). At DPR 1.5 every benchmark scene holds
60 FPS with zero long frames. The visual difference at 1.5 vs 2 is minor with SMAA enabled.

### DEC-017 — Software WebGL starts on the Low tier
Unmasked renderer strings matching SwiftShader, llvmpipe, softpipe or the Basic Render Driver set
the Low tier at startup in Auto mode. Without this, the High tier took over a second per frame and
starved the main thread, freezing input and slowing the simulation loop (observed in e2e under
software rendering). Users can still pick a tier manually.

### DEC-018 — Procedural assets only; picking through invisible volumes
All 3D assets are generated in code (`docs/design/ASSETS.md`), which avoids licensing risk and
download weight. Detailed instanced meshes skip raycasting. One invisible box per bay, vehicle and
dock makes picking precise and O(entities), independent of triangle count.

### DEC-019 — One-way circulation network for material-handling vehicles (Phase 2)
**Context:** two-way single-lane aisles caused head-on livelocks that back-off and refuge heuristics
could not resolve reliably (12-seed sweep). **Decision:** the west cross aisle runs north, the east
cross aisle south, the back aisle east, the front aisle west, and middle aisles alternate; dock paths
and the charging road stay two-way, as exclusive zones. **Consequences:** no head-on conflicts; the
graph must be strongly connected (validated); trips are longer (~1,000 ticks per task, measured),
so workloads were re-calibrated. Routing and dispatch are deliberately isolated
(`ops/nav.ts`, `ops/systems/dispatch.ts`) so alternative flow and dispatch policies can be compared
as scenarios later.

### DEC-020 — One task at a time per dock
The dispatcher does not start a task whose pick-up or drop-off is in a dock path that already has an
active task, so vehicles never queue on the front aisle for a busy dock. This caps per-dock
throughput, a policy to revisit with measured scenario comparisons.

### DEC-021 — Renderer draws operational state one tick behind, interpolated (Phase 2)
**Context:** the simulation advances in fixed 100 ms ticks; drawing only the latest tick makes
vehicles jump. **Decision:** the store keeps the latest published state and the state one tick
earlier; the renderer draws `lerp(previous, latest, tickProgress)` from the simulation's own pose
functions (`equipmentPose`, `truckPose`, `palletWorld`). A paused run draws the latest tick
exactly. **Consequences:** smooth motion with at most one tick (100 ms simulated) of display lag;
interpolation is visual only and never feeds back into state. Browser tests compare rendered poses
with authoritative poses while paused, where they must be identical.

### DEC-022 — Operator commands use the same command path as every other input (Phase 2)
UI forms build commands and submit them to the runner (`submitCommand`): schema errors are rejected
at submit, business rules by the engine on the next tick, and accepted commands enter the replayable
command log. The UI shows the engine's rejection code and message, plus an operator explanation per
code (`REJECTION_EXPLANATION`). Nothing in the UI changes state directly.

### DEC-023 — The simulation clock does not depend on the frame rate (Phase 2)
**Context:** real time was fed to the simulation only from `requestAnimationFrame`, capped at 250 ms
per frame. On a slow renderer (software WebGL on a 2-core CI runner, under ~4 FPS) the simulation
fell behind its requested speed: CI measured 8–24 ticks/s at 8× instead of 80, and long browser
workflows timed out (CI runs 39463588226, 39469515802). **Decision:** a 50 ms timer feeds time too,
on the same clock as the frames, so each millisecond is fed exactly once; the 250 ms cap still
applies per call. **Consequences:** the simulation keeps its requested speed regardless of frame
rate (measured locally: 79.9 ticks/s at 8× with frames slowed to ~2 FPS); a backgrounded tab still
cannot cause a catch-up burst, but it now keeps advancing slowly (throttled timers, 250 ms per call)
where it previously paused. Rendering is unchanged: it interpolates from `tickProgress` per frame.
