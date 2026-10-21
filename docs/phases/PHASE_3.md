# Phase 3 — Real Data Engineering

**Branch:** `feature/p3-data-engineering` · **Base:** `main` @ `d2dc4d9` (PR #4, Phase 2, merged
2026-10-21; `main` CI run 39536339237: 4/4 jobs green)
**Status:** IN DEVELOPMENT. Sections marked *(plan)* describe intent, not results.

## 1. Starting point (verified 2026-10-21)

| Item | State |
|------|-------|
| `main` | `d2dc4d9`, Phase 2 merged; CI 4/4 green on the merge commit |
| API | FastAPI with `/health`, `/health/ready`, `/version` only; Alembic baseline creates schema `operations`, no tables |
| Event production | Only in the browser (`SimulationRunner` in `apps/web`); nothing leaves the browser |
| Event identity | `event_id = v8(cyrb128("<simulation_id>:<sequence>"))`, deterministic. Scenario configs use a fixed `simulation_id` per scenario, so two browser sessions of the showcase would produce the same IDs with different content |
| Contract | Zod (source of truth) → `data/schemas/domain-event.schema.json` → Pydantic mirror with drift tests; 13 event types |
| Infrastructure | Compose: PostgreSQL 18, `migrate`, `api`. No Kafka, object store or orchestrator |
| Machine | Docker Desktop with 4 GB memory, 8 CPUs; host ports 3000 and 8000 are used by other projects |
| MinIO images | Upstream repository archived; `minio/minio` removed from Docker Hub and quay.io tags gone. The pinned multi-arch build still published is `bitnamilegacy/minio:2025.7.23-debian-12-r5` (DEC-031) |

## 2. Plan *(plan)*

**Principle.** The TypeScript engine stays the only implementation of simulation rules. Everything
downstream of it stores, moves, validates and derives events; nothing re-simulates in Python.
PostgreSQL is the durable source of truth for runs, commands and events; Kafka, the lake and dbt
outputs are derived and rebuildable from it.

```text
 browser / headless recorder ──HTTP──► API ──1 transaction──► operations.simulation_runs
   (packages/recorder)                  │                      operations.command_log
                                        │                      operations.domain_events
                                        │                      operations.outbox
                                        ▼
                         outbox relay (lease per run, ordered, acks=all) ──► Kafka (KRaft)
                                                                              warehouse.domain-events.v1
                              ┌───────────────────────────────────────────────┤ key = simulation_id
                              ▼                                               ▼
              ledger consumer (dedup by event_id,              bronze consumer (raw Parquet → MinIO,
              aggregate_version checks, DLQ)                   manifest in PostgreSQL, DLQ)
                              │                                               │
                              ▼                                               ▼
              pipeline.ledger_events                s3://warehouse-lake/bronze/domain_events/...
                                                                              │
                                            dbt (DuckDB over S3) silver ─► gold (Parquet on MinIO)
                                                                              │
                         Airflow: refresh · backfill · reconciliation (PostgreSQL ↔ ledger ↔ bronze ↔ silver ↔ gold)
```

| Milestone | Content |
|-----------|---------|
| A Event store | Migration `0002`: runs, command log, append-only events, outbox, ingest batches. `PUT /api/v1/simulations/{id}` (register run), `POST …/batches` (commands + events, one transaction), `GET …/{id}` (status), `GET …/{id}/export` (replay input). Validation: contract (Pydantic), deterministic `event_id`, contiguous `sequence`, `aggregate_version` continuity, simulated-time consistency, batch limits, idempotent retries, 409 on conflicting duplicates |
| A′ Producers | `packages/recorder` (TypeScript): batches a runner's command log and events at tick boundaries, retries with backoff, idempotent `batch_id`. Used by the web app (opt-in "Record to API", fresh run ID per recorded session) and a headless CLI (`pnpm sim:record`). `pnpm sim:verify` replays an exported run in the TypeScript engine and compares every event |
| B Relay | Outbox → Kafka, one lease per run so a run's events are published in `sequence` order by one relay at a time; idempotent producer, `acks=all`; mark published only after delivery reports; bounded exponential backoff; attempts and errors recorded; heartbeat for health |
| C Consumers | Shared consumer loop (manual offset commits after durable work). **Ledger**: dedup on `event_id` in PostgreSQL, `aggregate_version` continuity, conflicting duplicates and regressions to the DLQ, gaps recorded as data-quality issues. DLQ = Kafka topic plus a durable `dead_letters` table |
| D Bronze | Parquet (PyArrow) on MinIO, hive-partitioned by `event_date` (simulated business date) and `event_type`; deterministic object keys from the Kafka offset range; manifest in PostgreSQL; every delivery kept (dedup happens in silver); rebuild-from-PostgreSQL path for any date range |
| E dbt | DuckDB adapter reading bronze from S3; silver (typed, deduplicated, version-aware, rejects kept) and gold (event volume, inventory movements, per-run activity, task and order lifecycles, data quality) written back as Parquet; schema and business tests |
| F Airflow | Custom image (dbt and pipeline in separate venvs); DAGs: lake refresh, date-range backfill, reconciliation; real tasks with retries and timeouts; reconciliation fails on violated invariants |
| G Local stack | Compose profile `data` (default `docker compose up` unchanged): Kafka (KRaft), topic init, MinIO, relay, two consumers, Airflow; health checks that test the service, not the process |
| H Proof | `scripts/data-platform-smoke.sh`: record a run → verify DB atomicity and replay → Kafka → ledger and bronze → dbt → Airflow → reconcile; restart and duplicate scenarios; injected discrepancy detected; exits non-zero on any failed step |

**Order:** A → A′ → B → C/D → E → F → G (grows with each milestone) → H → docs and PR.

**Out of scope:** scenario comparison, optimisation, AI, authentication, workers, conveyors, AMRs.
