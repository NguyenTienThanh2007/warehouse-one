# Architecture

**Status:** describes the implementation merged into `main` through Phase 3 (`0b25fa4`).
Components marked *(planned)* do not exist yet. The current 3D scene models one facility; multi-site
spatial hierarchy and inter-site logistics are planned for Phase 5, with city-scale expansion in Phase 6.

## 1. System overview

```text
 ┌──────────────────────────── Browser (apps/web) ────────────────────────────┐
 │ user input ─► commands ─► SimulationRunner ─► step() (packages/simulation, │
 │                              │ frozen state      pure, deterministic)       │
 │                              ▼                   │ domain events            │
 │        Zustand projection ─► R3F scene + HUD     │                          │
 │                                                  ▼                          │
 │                  RunRecorder (opt-in "Record run", packages/recorder)       │
 └──────────────────────────────────────────────────┬─────────────────────────┘
          headless: pnpm sim:record ────────────────┤ HTTP: run config, command log, events
                                                    ▼
 ┌────────────── apps/api (FastAPI) ── one transaction per batch ──────────────┐
 │ validate contract, event_id, sequence, aggregate_version, simulated time    │
 │ PostgreSQL operations.*: simulation_runs, command_log, domain_events        │
 │                          (append-only), outbox, ingest_batches              │
 └────────────────────────────────────────────────────┬────────────────────────┘
                     outbox relay (lease per run) ─────┤ acks=all, key = simulation_id
                                                      ▼
                         Kafka (KRaft) warehouse.domain-events.v1  ──► .dlq
                   ┌──────────────────────┴───────────────────────┐
                   ▼                                              ▼
   ledger consumer (dedup, versions)              bronze consumer (raw Parquet)
   PostgreSQL pipeline.consumer_events            MinIO s3://warehouse-lake/bronze/…
                                                  + pipeline.bronze_objects manifest
                                                                  │
                         dbt (DuckDB over S3): silver ─► gold (Parquet in the lake)
                                                                  │
  Airflow: lake refresh · backfill (rebuild bronze from PostgreSQL) · reconciliation
           (PostgreSQL ↔ ledger ↔ dead letters ↔ bronze ↔ silver ↔ gold) → reports
```

## 2. Ownership of state (single source of truth)

| State | Owner | Others hold |
|-------|-------|-------------|
| Simulation rules and operational state | **Simulation engine** (`packages/simulation`) | Projections only; Python never re-simulates |
| A recorded run: config, command log, events | **PostgreSQL** `operations.*` (append-only events and commands, enforced by triggers) | Kafka, bronze, ledger, silver and gold are **derived and rebuildable** |
| Delivery state | `operations.outbox` (relay), Kafka consumer offsets (consumers) | — |
| Processing state | `pipeline.*`: ledger, aggregate versions, dead letters, data-quality issues, bronze manifest, heartbeats, reconciliation reports | — |
| Analytical datasets | dbt silver/gold Parquet in the lake | Read-only for dashboards and AI (later phases) |
| UI state (selection, camera, panels) | Web app (Zustand) | — |

Rendering is an adapter. It reads the frozen state the runner publishes and cannot write to it.
Mutation attempts throw, and a test covers this.

## 3. Monorepo layout (actual)

```text
apps/web            Next.js app: HUD, 3D world (src/world: pure derivation, geometry, materials;
                    src/components/world: R3F scene, camera, lighting, effects), simulation loop
apps/api            FastAPI service (warehouse_api: ingestion, store, contracts) and the data
                    platform (warehouse_pipeline: relay, consumers, lake, reconciliation, CLI);
                    Alembic migrations; Dockerfile targets `api` and `pipeline`
packages/contracts  Zod schemas for commands and events; JSON Schema generation
packages/simulation Deterministic engine, runner, snapshots, replay, scenarios, benchmarks
packages/recorder   RunRecorder (web + headless), replay verification, sim:record / sim:verify
analytics/          dbt project (DuckDB over the S3 lake): staging, silver, gold, tests
infra/airflow       Airflow image, DAGs, DAG validation
scripts/            data-platform-smoke.sh (end-to-end proof)
data/schemas        Generated JSON Schemas (language-neutral contract)
data/fixtures       Deterministic reference runs (foundation-demo, operations-demo)
tests/e2e           Playwright browser tests (production build; recording needs an API)
tests/performance   Renderer frame-time benchmark, visual bookmark and operations captures
docs/               Product, architecture, data, design, phase records
.github/workflows   CI
```

Directories from the master brief that are **not yet created**, because nothing real would live in
them: `packages/graphics` and `packages/ui` (extracted from `apps/web` when a second consumer
appears). Phase 3 placed the dbt project in `analytics/` (its own uv project, so dbt's
dependencies never mix with the API's) and the orchestration in `infra/airflow`; the Compose file
stays at the repository root with a `data` profile. Integration tests live with the code they test
(`apps/api/tests/integration`). See DEC-007.

## 4. Simulation engine

- **Pure core:** `step(config, state, commands) → { state, events, rejections }`. The input state
  is never mutated (copy-on-write `TickDraft`). Tested with frozen inputs.
- **Fixed step:** `tick_ms` = 100 ms of simulated time. The runner turns real elapsed time × speed
  into whole ticks with an accumulator, caps ticks per frame (default 240) and reports dropped
  backlog. Pause stops the accumulator, so simulated time freezes.
- **Order within a tick:** increment tick → apply commands in submission order (each sees the
  previous one's effects, so conflicting commands are rejected rather than double-applied) → run
  systems in fixed order.
- **Randomness:** sfc32 PRNG whose 128-bit state lives *in* `SimulationState`. Snapshots
  capture it, so restore resumes the identical stream. ESLint forbids `Math.random`, `Date.now`,
  `performance.now` and `new Date()` in engine sources.
- **Identity:** event IDs are deterministic v8 UUIDs. A state fingerprint (`stateHash`, 128-bit
  non-cryptographic cyrb128 over canonical JSON) is used for replay and snapshot verification.
- **Snapshots:** `{snapshot_version, engine_version, config, state, state_hash}`. Loading verifies
  the version, config validity, hash integrity and invariants.
- **Replay:** `replay(config, commandLog, untilTick)` rebuilds identical state and events.
- **Systems:** Phase 0 has one, an optional seeded *synthetic workload* for demos and benchmarks.
  It goes through the same command handlers, so every invariant still applies.

Phase 1 added optional facility master data (DEC-014) and a scenario registry; neither changes the
simulation rules. Phase 2 adds orders, pallets, forklifts, pathfinding and trucks (workers deferred) as
additional systems and aggregates. Heavy runs may move into a Web Worker. The pure `step()` contract makes that a
transport change, not a redesign.

## 5. 3D world (Phase 1)

```text
SimulationConfig (locations, facility master data) ─┐
SimulationState.inventory (frozen) ─────────────────┼─► world/derive.ts (pure, unit-tested)
                                                    │     rack parts · pallet instances · pick volumes · counts
                                                    ▼
                          components/world/*  ─►  instanced meshes per material (≈110 draw calls)
                                                    │
               camera-rig (presets, framing.ts) ◄───┤──► scene-debug hook (read-only, tests/benchmarks)
```

- **No invented data:** a pallet instance exists only for a stored unit; docks and vehicles only for
  `facility` entries (DEC-014). Beam-level placement is a disclosed display convention (DEC-015).
- **Assets:** procedural, real-scale, merged per material and instanced (DEC-018, `docs/design/ASSETS.md`).
- **Picking:** invisible volumes per bay, vehicle and dock. Detailed meshes never raycast.
- **Quality:** High / Medium / Low tiers (DPR, shadows, N8AO, SMAA). Auto mode steps down via
  `PerformanceMonitor`, and software WebGL starts on Low (DEC-016, DEC-017).
- **States:** `useView().status` drives the loading overlay. Error boundary and context-loss
  handler give a recoverable error state while the simulation keeps running.

## 6. Backend

FastAPI app factory (`create_app(settings)`), configured by `WAREHOUSE_*` environment variables
through pydantic-settings.

- **Logging:** JSON logs to stdout with request IDs. A caller's `X-Request-ID` is accepted when
  safe, otherwise one is minted; either way it is echoed back.
- **Health:** liveness never touches dependencies. Readiness checks PostgreSQL with a 3 s connect
  timeout and returns 503 when it is down, hiding error class names in production.
- **Ingestion API (`/api/v1/simulations`, DEC-024):** run registration, atomic command and event
  batches, run status, and command and event export for replay. Errors are
  `{"error": {code, message, details}}` with stable codes.
- **Limits:** request bodies above 4 MiB are refused (413); a missing `Content-Length` gets 411.
- **Schema:** Alembic manages it. `0001` creates the `operations` schema; `0002` adds the event
  store, outbox and the `pipeline` schema, plus append-only triggers on events and commands.

## 7. Data platform (Phase 3)

1. **Event store (DEC-024):** each batch is stored in one transaction with its outbox rows (see
   `docs/data/EVENT_CONTRACT.md` for what is validated and what is trusted).
2. **Relay (DEC-025):** one lease per run (`FOR UPDATE SKIP LOCKED`, short transactions). It
   produces in `sequence` order with an idempotent `acks=all` producer and marks only the
   acknowledged prefix. Backoff is bounded and exponential, and it heartbeats for health.
3. **Kafka (DEC-026):** KRaft single broker locally. The events topic has 6 partitions and is
   keyed by `simulation_id`; a DLQ topic sits beside it. Delivery is at least once.
4. **Consumers (DEC-027):** manual commits after durable work, contract validation and a durable
   DLQ.
   - The **ledger** deduplicates by `event_id` and checks versions.
   - **Bronze** writes Parquet with deterministic keys plus a manifest, and keeps every delivery.
5. **Lake (DEC-028, DEC-031):** any S3-compatible store; locally a pinned MinIO build. Layout is
   `bronze/domain_events/event_date=…/event_type=…/`, `silver/*.parquet`, `gold/*.parquet` and
   `reports/reconciliation/*.json`.
6. **dbt (DEC-029):** DuckDB reads bronze from S3 and writes silver and gold as Parquet (full
   refresh). Tests cover keys, relationships, accepted values and business invariants.
7. **Airflow (DEC-030):** lake refresh, date-range backfill and reconciliation. Tasks call the
   pipeline and dbt CLIs in isolated virtualenvs, and the reconciliation fails on any violated
   invariant.

## 8. Cross-cutting

- **Config:** environment variables only. `.env.example` documents them. No secrets in the repo.
  `NEXT_PUBLIC_*` values are public by definition.
- **Security headers** on the web app (nosniff, frame deny, referrer policy). CORS on the API is an
  explicit allow-list.
- **Observability:** structured JSON logs from the API and every pipeline process. Heartbeats in
  `pipeline.heartbeats` (with Kafka reachability and consumer lag) back the health checks.
  Reconciliation reports are stored in PostgreSQL and the lake. Metrics and tracing are not
  implemented.
- **Quality gates:** see `docs/phases/PHASE_0.md` and `.github/workflows/ci.yml`.
