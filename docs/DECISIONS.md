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

## Phase 3 — Data engineering

### DEC-024 — PostgreSQL event store with an HTTP ingestion boundary (Phase 3)
**Context:** events are produced only by the TypeScript engine (browser or headless). Python must
not re-implement simulation rules. **Decision:** producers send a run's registration (config,
seed, engine version), its command log and its events in batches to the API, which stores them in
one transaction per batch: `simulation_runs`, `command_log`, `domain_events` (append-only, unique
`event_id` and `(simulation_id, sequence)`), `outbox`, `ingest_batches`. The API **validates** the
contract (Pydantic mirror), the deterministic `event_id`, gap-free `sequence`, `aggregate_version`
continuity per aggregate and simulated-time consistency. It does **not** verify business
semantics; that is done by replaying the stored config and command log in the TypeScript engine
(`pnpm sim:verify`) and comparing every event. **Consequences:** one source of truth for rules; the
API trusts that a producer ran the engine honestly, and the replay check can prove it after the
fact. Recorded sessions get a fresh `simulation_id` (the scenario configs share one per scenario).

### DEC-025 — Transactional outbox relay with a lease per run (Phase 3)
Each run is relayed by at most one relay instance at a time (a lease column on
`simulation_runs`, claimed with `FOR UPDATE SKIP LOCKED`, renewed while working). The relay reads
the run's unpublished rows in `sequence` order, publishes them with an idempotent producer
(`acks=all`), and marks only the contiguous prefix confirmed by delivery reports as published. No
database transaction is held across network calls. Failures increment attempts, store the error
and set a bounded exponential backoff on the run. A crash after the broker acknowledged but before
the database update causes redelivery, which downstream consumers tolerate (DEC-027).

### DEC-026 — Kafka topics, keys and delivery semantics (Phase 3)
Topic `warehouse.domain-events.v1`, 6 partitions, key = `simulation_id`, value = the event's
canonical JSON, headers carry `event_id`, `event_type`, `schema_version`. A run's events share a
partition, so per-run order is the publish order. Dead letters go to
`warehouse.domain-events.v1.dlq`. Delivery is **at least once**. Local settings (single broker,
replication factor 1, 7-day retention) are development-only.

### DEC-027 — Idempotent consumers, manual commits and a durable DLQ (Phase 3)
Consumers commit offsets only after their durable work (PostgreSQL rows, Parquet objects plus
manifest) has succeeded. The ledger consumer deduplicates on `event_id` (primary key) and checks
`aggregate_version` continuity: an identical redelivery is skipped and counted; the same
`event_id` with different content, and a version regression with a new `event_id`, go to the DLQ;
a forward gap is processed and recorded as a data-quality issue. Contract violations go to the DLQ
with the original bytes, source topic/partition/offset, error class and detail, both on the DLQ
topic and in `pipeline.dead_letters`. Infrastructure failures (database, object store) are never
dead-lettered: the batch is retried with bounded backoff and the offset is not committed.

### DEC-028 — Bronze layout: raw Parquet, deterministic keys, dedup later (Phase 3)
`s3://warehouse-lake/bronze/domain_events/event_date=YYYY-MM-DD/event_type=<type>/` with object
names derived from the Kafka offset range (`part-<partition>-<first>-<last>.parquet`), so
reprocessing the same range rewrites the same keys with the same content. `event_date` is the
simulated business date (`occurred_at`), not the ingestion date. Bronze keeps every delivery
(auditable); deduplication by `event_id` happens in silver. A PostgreSQL manifest records every
object; the reconciliation compares it with the bucket. Bronze can be rebuilt for any date range
from the PostgreSQL event log (`source = postgres-rebuild`).

### DEC-029 — dbt with DuckDB over the S3 lake (Phase 3)
dbt-duckdb reads bronze Parquet from MinIO through DuckDB's `httpfs` and writes silver and gold as
Parquet back to the lake (external materializations); the DuckDB file is a disposable scratch
database. Alternatives: dbt-postgres would load the lake back into the operational database;
Spark/Trino are too heavy for a laptop. Models are full refreshes (small data, deterministic
results); a date-range backfill re-sources bronze for the range and rebuilds.

### DEC-030 — Airflow 3 standalone with tool virtualenvs (Phase 3)
Local Airflow runs `airflow standalone` (LocalExecutor) on the shared PostgreSQL server (separate
`airflow` database) in a custom image based on `apache/airflow:3.3.2-python3.12`. dbt and the
pipeline CLI live in their own virtual environments inside the image, so their dependencies never
conflict with Airflow's. Tasks call those CLIs; they do real work and fail on non-zero exit.

### DEC-031 — Object store image provenance (Phase 3)
The MinIO project is archived upstream and its official images are no longer published. Local
development pins `bitnamilegacy/minio:2025.7.23-debian-12-r5` (multi-arch, frozen). All pipeline
code talks plain S3 (PyArrow `S3FileSystem`, DuckDB `httpfs`) with endpoint, region and path-style
settings from the environment, so a maintained S3-compatible store can replace it by changing the
Compose service only. Not for production use.

### DEC-032 — The logistics network wraps the facility; the DC is not modelled twice (Phase 5)
A multi-site world is an optional `config.network` (sites, stands, roads, line-haul trucks,
transfer lanes) and `state.network`, stepped by one more system after the facility's operations.
The distribution centre stays the existing facility simulation: a line-haul truck reaching its gate
is handed over through the DC's own command handlers (`order.create`, `truck.schedule_inbound`), so
every DC rule (yard slots, storage capacity, stock) applies unchanged; the DC truck is held in its
yard slot (`hold_ticks_left`, set only for these trucks) while the line-haul truck reverses in, and
the network takes it back when the DC truck departs. Other sites are aggregate models (pallet
counts per SKU, doors handling one pallet per fixed interval). Alternatives: a second full
facility model per site (much larger change, deferred to a later increment); a purely visual
network (rejected: it would show activity the simulation does not have). Configs without a network
keep the Phase 2 state shape, so existing scenarios and golden fixtures are byte-identical.

### DEC-033 — Deterministic network movement and reservations (Phase 5)
Roads are an undirected graph with integer-millimetre lengths (`sqrt` of integer deltas, not
`Math.hypot`); routes are Dijkstra with ties broken by node id; trucks advance whole millimetres
per tick and keep a fixed headway behind trucks on the same directed segment (equal progress: the
lower id goes first). A truck reserves its destination stand (door, else staging stall; at the DC a
staging stall as fallback for admission) before it leaves, so arrivals never need a free place that
might not exist; without a reservation it waits where it is and retries. Stock is allocated at the
origin and capacity reserved at the destination when a transfer is planned. Random draws come from
the in-state RNG and happen only when a lane or vessel is due. Poses are derived from state by
`linehaulPose` and never stored as floats.

### DEC-034 — Network events and the transfer command (Phase 5)
Three event types, `schema_version` 1: `transfer.status_changed` (aggregate `transfer`),
`linehaul.status_changed` (aggregate `linehaul`) and `site.stock_changed` (aggregate `site`;
pallets per SKU or containers). One command, `transfer.request`. They are added to the Zod
contracts, the generated JSON Schemas, the Pydantic mirror, and dbt silver's accepted
`(event_type, schema_version)` pairs in the same change, with a reference fixture
(`data/fixtures/network-demo`) parsed by both languages. Stock at aggregate sites changes when a
whole load is handled (one event per SKU), not per pallet; the truck's `handled` counter shows
progress in between.

### DEC-035 — Network rendering: merged static layout, cutaways, camera-following shadows (Phase 5)
All static network geometry (roads, markings, pads, fences, buildings cut around their real doors,
cranes, trees, lights) is generated from config once and merged per material, so the world adds
about fifty draw calls. Walls and roofs of buildings with an interior are separate so the facility
view can cut them away like the DC's. The sun's shadow frustum follows the camera target and scales
with distance, snapped to texels. Site labels are DOM elements projected every frame (beneath the
HUD), not WebGL text or per-label React roots. The default scenario is the network; the single-site
DC is `?scenario=showcase`.

### DEC-036 — Analytics are served from published snapshots in PostgreSQL (Phase 4)
The dbt gold models (Parquet in the lake) stay the analytical source of truth. After a refresh,
`warehouse-pipeline publish-analytics` copies one reconciled gold build into `analytics.*` in
PostgreSQL as an immutable snapshot (one transaction; the last 20 kept), and the read API serves
only those snapshots plus pipeline state. Alternatives: the API reading Parquet through DuckDB on
every request (puts the lake, S3 credentials and DuckDB in the API; no stable unit of "what was
published"; unavailable whenever MinIO is), or materialising gold into PostgreSQL by dbt (a second
build of the models). Facts are copied at row level (tasks, orders, transfers) and events per
simulated minute, so the API can answer any time window with exact counts and percentiles instead
of pre-aggregating a fixed set. The snapshot is derived data: dropping it loses nothing.

### DEC-037 — Two clocks in analytics, never mixed; windows in simulated time (Phase 4)
Business time is the simulated clock: each run's origin (`run_epoch`, from `occurred_at −
simulation_time_ms`, checked constant by a dbt test) plus simulated milliseconds. Buckets are
offsets on that clock, so nothing depends on a time zone or on when events were ingested.
Publication, freshness, heartbeats and reconciliation are wall clock and labelled as such in the
API (`generated_at`, `server_time`, `*_recorded_at`) and the UI. Windows are half-open, snapped
outwards to the series resolution (1 to 1,440 simulated minutes, at most 240 points), at most 31
simulated days, and rejected with a code when invalid.

### DEC-038 — A snapshot is published only when its own reconciliation passed (Phase 4)
The publisher refuses unless a reconciliation report that passed, with the models checked,
finished after the gold build. DAG runs pass `--cleared-by airflow:<dag>:<run_id>`, so the report
of the same run decides even when another DAG's reconciliation finishes in between; manual runs use
the latest report. When publication is refused the previous snapshot stays current, and the status
endpoint reports the pipeline's problems (`degraded`) next to it rather than hiding the data or
presenting it as current.
