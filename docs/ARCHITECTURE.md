# Architecture

**Status:** describes what exists after Phase 0, then the target architecture. Components marked
*(planned)* do not exist yet.

## 1. System overview

```text
                          ┌─────────────────────────────── Browser ───────────────────────────────┐
                          │  apps/web (Next.js 16, React 19)                                       │
 user input ──► commands ─┼─► SimulationRunner ──► step() (packages/simulation, pure, deterministic)│
                          │        │  frozen state            │ domain events                       │
                          │        ▼                          ▼                                     │
                          │   Zustand projection ──► R3F scene + HUD (read-only)                    │
                          └────────────────────────────────────┬───────────────────────────────────┘
                                                               │ (Phase 3) events / commands over HTTP
                          ┌────────────────────────────────────▼───────────────────────────────────┐
                          │  apps/api (FastAPI)  ── PostgreSQL 18 (operational store)               │
                          │   /health /health/ready /version          + outbox, event log (planned) │
                          └────────────────────────────────────┬───────────────────────────────────┘
                                                (planned)      ▼
                     outbox relay ─► Kafka ─► consumers ─► MinIO (Parquet bronze) ─► dbt silver/gold
                                                                    └─► DuckDB/Postgres marts ─► Analytics UI, AI
```

## 2. Ownership of state (single source of truth)

| State | Owner | Others hold |
|-------|-------|-------------|
| Warehouse operational state (inventory, later orders, vehicles, workers) | **Simulation engine** (`packages/simulation`) | Projections only |
| Command log + snapshots of a run | Simulation runner today, durably in PostgreSQL from Phase 3 | — |
| Domain events | Emitted by the engine, made durable by the API's event log and outbox (Phase 3) | Kafka, lake and dbt are **derived and replayable** |
| Analytical aggregates | dbt gold models | Read-only in the dashboards and AI |
| UI state (selection, camera, panels) | Web app (Zustand) | — |

Rendering is an adapter. It reads the frozen state the runner publishes and cannot write to it.
Mutation attempts throw, and a test covers this.

## 3. Monorepo layout (actual)

```text
apps/web            Next.js app: HUD, R3F scene, in-browser simulation loop
apps/api            FastAPI service, SQLAlchemy/Alembic, Pydantic contract mirror, Dockerfile
packages/contracts  Zod schemas for commands and events; JSON Schema generation
packages/simulation Deterministic engine, runner, snapshots, replay, scenarios, benchmarks
data/schemas        Generated JSON Schemas (language-neutral contract)
data/fixtures       Golden deterministic run used by TS and Python tests
tests/e2e           Playwright browser tests (production build)
tests/performance   Renderer frame-time benchmark
docs/               Product, architecture, data, design, phase records
.github/workflows   CI
```

Directories from the master brief that are **not yet created**, because nothing real would live in
them: `packages/graphics` and `packages/ui` (extracted from `apps/web` when a second consumer
appears), `data/dbt` and `data/pipelines` (Phase 3), `infrastructure/` (Kafka/MinIO/monitoring
compose files, Phase 3; the Phase 0 compose file lives at the repo root),
`tests/integration` (Phase 0 integration tests live with the API in `apps/api/tests/integration`).
See DEC-007.

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

Phase 2 adds orders, pallets, forklifts, pathfinding, workers and trucks as additional systems and
aggregates. Heavy runs may move into a Web Worker. The pure `step()` contract makes that a
transport change, not a redesign.

## 5. Backend

FastAPI app factory (`create_app(settings)`), configured by `WAREHOUSE_*` environment variables
through pydantic-settings. JSON logs to stdout with request IDs: accepted from `X-Request-ID` when
safe, minted otherwise, and echoed back. Liveness never touches dependencies. Readiness checks
PostgreSQL with a 3 s connect timeout and returns 503 when it is down, hiding error class names in
production. Alembic manages schema changes. The baseline migration creates the `operations` schema
only, and Phase 3 adds the outbox and event-log tables.

## 6. Data platform (planned, Phase 3)

1. API persists commands and events in one transaction (event log + **transactional outbox**).
2. Relay publishes outbox rows to Kafka (key = `simulation_id`), marks them sent, and retries with backoff.
3. Consumers: idempotent upsert keyed on `event_id`, `aggregate_version` continuity checks,
   dead-letter topic for poison messages.
4. Bronze: raw events as Parquet on MinIO, partitioned by `event_date/event_type`.
5. dbt (DuckDB adapter over Parquet, or Postgres) builds silver (typed, deduplicated) and gold facts
   and dimensions, with tests for uniqueness, relationships, not-null, accepted values and source freshness.
6. Airflow orchestrates batch loads, backfills and reconciliation reports.

## 7. Cross-cutting

- **Config:** environment variables only. `.env.example` documents them. No secrets in the repo.
  `NEXT_PUBLIC_*` values are public by definition.
- **Security headers** on the web app (nosniff, frame deny, referrer policy). CORS on the API is an
  explicit allow-list.
- **Observability:** structured logs today. Metrics and tracing are introduced with the pipeline
  (Phase 3) where there is something to observe.
- **Quality gates:** see `docs/phases/PHASE_0.md` and `.github/workflows/ci.yml`.
