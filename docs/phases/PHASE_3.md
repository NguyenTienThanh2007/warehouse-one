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

## 3. What was built

| Milestone | Where | Summary |
|-----------|-------|---------|
| A Event store | `apps/api/src/warehouse_api/{store,ingest,api}`, migration `0002_event_store` | `operations.simulation_runs`, `command_log` (ordered by `log_index`), `domain_events` (unique `event_id`, `(simulation_id, sequence)` and aggregate versions; UPDATE/DELETE rejected by triggers), `outbox`, `ingest_batches`; `PUT/POST/GET /api/v1/simulations…`; one transaction per batch; validation and duplicate rules in `docs/data/EVENT_CONTRACT.md`; Python port of the deterministic event ID and a Pydantic command mirror, both checked against the TypeScript fixtures |
| A′ Producers | `packages/recorder`, `apps/web/src/lib/sim/store.ts`, `system-status.tsx` | `RunRecorder` (ordered batches at tick boundaries, stable `batch_id` across retries, bounded backoff, stops on 4xx); web **Record run** (fresh `simulation_id` per recorded session); `pnpm sim:record` (headless) and `pnpm sim:verify` (replay in the engine and compare every event) |
| B Relay | `warehouse_pipeline/relay.py`, `kafka.py` | lease per run with `FOR UPDATE SKIP LOCKED`; ordered idempotent `acks=all` produce; marks only the acknowledged prefix; attempts, errors, exponential backoff; graceful shutdown releases leases; heartbeat with Kafka reachability |
| C Consumers | `consumer.py`, `ledger.py` | manual commits after durable work; contract validation; dead letters to the DLQ topic and `pipeline.dead_letters`; infrastructure failures retried then rewound (never dead-lettered); ledger dedup, version and sequence checks |
| D Bronze | `lake.py`, `bronze.py` | PyArrow Parquet (zstd) on S3, hive-partitioned by simulated `event_date` and `event_type`; deterministic keys; manifest; every delivery kept; rebuild from PostgreSQL for a date range (prunes manifest entries of lost objects) |
| E dbt | `analytics/` | silver: deduplicated, version-aware, rejects listed; typed families; gold: event volume, inventory movements, pallet flows, task lifecycle, order fulfilment, run activity, data quality; 52 tests incl. 7 business invariants |
| F Airflow | `infra/airflow` | image with isolated pipeline and dbt venvs; DAGs `warehouse_lake_refresh`, `warehouse_lake_backfill`, `warehouse_reconciliation`; `lake` pool; DAG validation script |
| Reconciliation | `reconcile.py` | settled source events vs ledger, dead letters, data-quality issues, bronze (rows, hashes, manifest vs objects), silver, gold; report in PostgreSQL and the lake; exit 1 on violations |
| G Local stack | `docker-compose.yml` (profile `data`), `apps/api/Dockerfile` (targets `api`, `pipeline`) | Kafka 4.2.2 KRaft, MinIO, init, relay, two consumers, Airflow 3.3.2 on its own database; health checks test the service (Kafka API request, MinIO readiness, heartbeat freshness, Airflow scheduler and DAG processor) |
| H Proof | `scripts/data-platform-smoke.sh`, `warehouse-pipeline status/replay` | 10 steps, 18 checks; exits non-zero on the first failure |

## 4. Verification (local, Apple M2, Docker Desktop with 4 GB)

All results below were run on this machine against real services (a throwaway PostgreSQL 18,
Kafka 4.2.2 and MinIO for the Python tests; a separate Compose project with the full stack for the
smoke test). Nothing here is a CI result.

| Check | Result |
|-------|--------|
| `pnpm check` (format, lint, typecheck, unit tests, build) | PASS: contracts 26, simulation 121, recorder 10, web 60 |
| JSON Schema regeneration | no diff |
| Phase 0 golden fixture | byte-identical (`git diff` empty; golden test passes) |
| Python: ruff, ruff format, mypy `--strict` (30 files, both packages) | PASS |
| Python unit tests | 41 passed |
| Python integration, PostgreSQL | 24 passed (ingestion: atomicity, retries, overlap, conflicts, gaps, versions, contract, limits, append-only, concurrency; migrations up/down) |
| Python integration, Kafka + S3 | 18 passed (relay 6, consumers/bronze 7, reconciliation 5) |
| dbt build on real pipeline output | 68/68 (16 models, 52 tests) |
| Airflow DAG validation (in the image) | OK: 3 DAGs, 9 tasks |
| Browser tests, retries disabled (Phase 0–2 regression) | GPU: 23 passed, 1 skipped (recording, no API); `CI=1` (SwiftShader): 23 passed, 1 skipped |
| Browser recording to the API (`RECORDING_API_URL`) | PASS: browser run stored completely, replays to identical events |
| Replay verification (`pnpm sim:verify`) | 716/716 (showcase, 3,000 ticks) and 197/197 (operations demo) events identical |
| Full stack health (`--profile data up --wait`) | all services healthy in ~33 s after the images were built |
| **Smoke test** | **PASS: 18 checks in 220 s** (see below) |

Smoke steps (one run, `scripts/data-platform-smoke.sh`):
1. Record: run A, 197 events and 9 commands.
2. Stored atomically, and `sim:verify` passes.
3. Outbox drained.
4. Ledger 197; bronze 197 rows in 10 Parquet objects.
5. Refresh DAG success; gold has 197 events; reconciliation passed.
6. **Kafka stopped:**
   - the API still stored run B's 612 events;
   - the relay reported degraded;
   - after Kafka returned, all 612 were published and consumed.
7. **MinIO stopped:**
   - the ledger kept up with run C (106 events);
   - bronze caught up after MinIO returned, with no dead letters.
8. **Run A replayed (every event delivered twice):**
   - the ledger still counts 197, with 394 deliveries;
   - bronze holds 394 rows;
   - after a refresh, gold still counts 197.
9. **Relay and consumers restarted:** run D (76 events) processed, and run A unchanged.
10. **Bronze object deleted:**
    - the reconciliation DAG failed with `missing_in_bronze`;
    - the backfill DAG rebuilt the date from PostgreSQL;
    - reconciliation passed again.

Footprint of the running stack (`docker stats`):

| Service | Memory |
|---------|-------:|
| Airflow | 1.17 GiB |
| Kafka | 321 MiB |
| PostgreSQL, MinIO, API, relay, each consumer | 51–75 MiB each |
| **Total** | **≈ 1.9 GiB** |

Images: pipeline 628 MB; Airflow 4.97 GB (the official image plus two tool environments). The first
Airflow build took about 10 minutes.

## 5. Limitations and risks

1. **Development-only infrastructure:**
   - single Kafka broker with replication factor 1;
   - no TLS or authentication on Kafka, MinIO or Airflow;
   - Airflow runs `standalone` without login;
   - MinIO is a frozen legacy build (DEC-031). Replace the Compose service for anything beyond local
     use; the code talks plain S3.
2. **The ingestion API has no authentication.** Anyone who can reach it can record runs. It must
   not be exposed before authentication exists (later phase).
3. **Business semantics are trusted at ingestion.** The API validates contract, identity, order and
   versions; `pnpm sim:verify` checks semantics by replay, but it is run by the smoke test and on
   demand, not automatically for every recorded run.
4. **Full-refresh models.**
   - Silver and gold are rebuilt from all of bronze on every run. Cost grows with the lake;
     incremental models are not implemented.
   - A backfill re-sources bronze for its date range and rebuilds every model.
5. **Small files.**
   - Bronze writes one object per consumer batch, partition, date and event type.
   - Compaction is not implemented.
6. **In-memory reconciliation.** The reconciliation loads event-ID sets into memory: right for
   simulation-scale data, not for very large lakes.
7. **Throughput is not benchmarked.** Pipeline throughput was not measured. The ledger processes
   records one by one in a transaction per batch.
8. **dbt-duckdb writes an all-NULL placeholder row for empty external models.** Readers outside
   dbt must filter it (the reconciliation does).
9. **Dead letters never clear on their own.** Reconciliation fails while any are in scope, and
   there is no tool yet to acknowledge or replay them.
10. **Browser recording:**
    - it starts a new run (fresh `simulation_id`), and a page reload ends that run;
    - the API URL is fixed at web build time (`NEXT_PUBLIC_API_URL`).
11. **Noisy consumer logs during a broker outage.** Consumers log a stack trace per failed poll
    cycle while the broker is down (they recover without intervention).
12. **CI for this branch:** see §6 (pending until the pull request runs).

## 6. CI

To be recorded from the pull request's run.

## 7. Acceptance checklist

| Requirement | Status | Evidence |
|-------------|--------|----------|
| PostgreSQL event log and outbox; atomicity and idempotency tests | done | §4 PostgreSQL integration; smoke step 2 |
| Relay and consumers: retries, ordering, dedup, DLQ | done | relay and consumer integration tests; smoke 3–9 |
| Real Parquet bronze in MinIO | done | bronze tests; smoke step 4 (read back with DuckDB) |
| dbt silver/gold built and tested on real data | done | 68/68; smoke step 5 |
| Airflow processing, backfill, reconciliation doing real work | done | smoke steps 5, 8, 10 |
| Reproducible end-to-end smoke test | done | §4 |
| Failure, restart and duplicate behaviour proven | done | smoke 6–10; integration tests |
| Phase 0–2 functionality and contracts intact | done locally | `pnpm check`; golden fixture; browser tests (§4) |
| Documentation reflects the implementation | done | this file, EVENT_CONTRACT, ARCHITECTURE, DEVELOPMENT, DECISIONS |
| CI passes on a reviewable PR | pending | §6 |
