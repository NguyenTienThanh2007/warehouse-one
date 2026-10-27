# Phase 4 — Operations analytics (published, reconciled, honest)

**Branch:** `feature/p4-analytics-refresh` · **Base:** `main` @ `9459fd5` (Phases 0–3 and 5 merged,
navigation fix PR #8 merged; `main` CI run 39717397640: 5/5 jobs green)
**Status:** MERGED into `main` as `5490c54` (PR #9, 2026-10-23). Follow-up PR #10 (`b2ccfdc`,
2026-10-25) fixed the local API connection and the dashboard's error states.

PR #6 (closed, unmerged) proposed a Phase 4 scope in prose; nothing from its branch is used.
This phase was built from what the code supports.

## 1. Starting point (verified 2026-10-23)

| Area | What existed |
|------|--------------|
| Gold models (dbt, DuckDB → Parquet in MinIO) | `gold_simulation_activity`, `gold_event_volume_daily`, `gold_inventory_movements`, `gold_pallet_flows`, `gold_task_lifecycle`, `gold_order_fulfilment`, `gold_data_quality`; no model for the Phase 5 transfers; the only time series was per simulated **day** (useless for runs of minutes to hours) |
| Pipeline state (PostgreSQL `pipeline.*`) | reconciliation reports, component heartbeats, dead letters, outbox |
| API | ingestion only (`/api/v1/simulations`); nothing read the lake |
| Web | Analytics mode shown as "Coming soon · Phase 4" (PR #8) |
| Orchestration | `warehouse_lake_refresh` (every 30 min): health → dbt build → freshness + reconcile; backfill and reconciliation DAGs |

## 2. Architecture

```text
recorded runs → PostgreSQL event log → Kafka → bronze (MinIO) → dbt silver/gold
                                                                  │
            Airflow: dbt build → reconcile (must pass) → publish-analytics
                                                                  ▼
                              PostgreSQL analytics.* (immutable snapshots, last 20 kept)
                                                                  ▼
                      GET /api/v1/analytics/{status, runs, runs/{id}}  (read-only)
                                                                  ▼
                                   Web: Analytics mode (dashboard)
```

- **One source of truth, one serving copy.** Gold Parquet is the analytical truth; a snapshot is
  a derived, immutable copy of one reconciled gold build, written in one transaction
  (`warehouse_pipeline/analytics.py`). The API reads only snapshots and pipeline state, never the
  lake and never operational simulation state (DEC-036).
- **Publication gate.** A snapshot is published only when the reconciliation of the same DAG run
  passed, checked the models, and finished after the gold build (`--cleared-by`). Otherwise the
  previous snapshot stays current and the API reports why (DEC-038).
- **Two clocks, never mixed** (DEC-037). Business time is simulated (`run_epoch + simulated ms`);
  snapshot age, heartbeats and reconciliation times are wall clock and labelled as such.

## 3. Windows and resolution

A window is a half-open range `[from, to)` of simulated business time on one run (default: the
whole run). The API validates it (`from < to`, at most 31 simulated days, overlapping the run),
clamps it to the run (reported as `clamped`) and snaps it outwards to whole buckets of the
**series resolution**: the smallest of 1, 5, 15, 60, 180, 360 or 1,440 simulated minutes that keeps
the series at ≤ 240 points. Event-level counts are published per simulated minute and summed;
tasks, orders and transfers are counted by the time of the transition being measured.

## 4. Metrics catalogue (catalogue version 1)

Every metric is per run and per window unless marked. Source models are dbt gold models; columns
are copied into `analytics.*` at publication. Tests listed are automated and run in CI.

| Metric | Meaning and calculation | Source (model · columns) | Window rule | Limitations | Tests |
|--------|-------------------------|--------------------------|-------------|-------------|-------|
| `events` | Distinct domain events (deduplicated by `event_id`) | `gold_activity_1m` · `events` by `event_type`, `bucket_ms` | minute buckets in the window | Includes all event types (DC and network) | dbt `assert_activity_buckets_match_runs`; API `test_whole_run_totals_equal_the_gold_rows`; smoke: equals source and the reference |
| `events_by_type` | `events` split by type; the UI shows the 7 largest + Other | same | same | — | web contract test: sums to `events` |
| `tasks_created` / `tasks_completed` / `tasks_cancelled` | Tasks whose creation / completion / cancellation falls in the window | `gold_task_lifecycle` · `created_ms`, `completed_ms`, `cancelled_ms` | by the transition's time | A task created before the window and completed inside counts as completed only | integration: hand-computed totals and the half-open edge; smoke: equals the operations-demo reference by type |
| `task_cycle_p50_ms`, `_p90_ms` | Median / 90th percentile of `completed_ms − created_ms` (continuous percentile) | `gold_task_lifecycle` | tasks completed in the window | Simulated time; queueing and travel are not separated | integration: 840 s / 1,272 s on the hand-computed set |
| `task_wait_p50_ms` | Median of `assigned_ms − created_ms` | same | tasks assigned in the window | — | integration |
| `tasks_completed_per_hour` | `tasks_completed` / window length in simulated hours | derived | window length after snapping | Short windows give noisy rates | — |
| `tasks_by_type` | The task counts and cycle percentiles per `task_type` | same | same | — | smoke + integration |
| `orders_opened` / `_shipped` / `_cancelled` | Orders whose opening / shipment / cancellation is in the window | `gold_order_fulfilment` · `opened_ms`, `shipped_ms`, `cancelled_ms` | by the transition's time | — | integration, smoke (reference) |
| `orders_open_at_end` | Orders opened before the window's end and neither shipped nor cancelled by then | same | at `to` | — | integration (edge at `to`) |
| `order_lead_p50_ms`, `_p90_ms` | Percentiles of `shipped_ms − opened_ms` | same | orders shipped in the window | — | integration |
| `pallets_created` | Pallets created (`pallet.created`) | `gold_pallet_flows` · `flow = created`, `cause_or_reason` | minute of `occurred_at` | — | unit (read_gold), integration |
| `pallets_received` | `pallets_created` with cause `receive` or `inbound_truck` (stock received into the DC) | same | same | Opening stock received at tick 1 counts as received | integration |
| `pallets_moved` | Pallet moves, by `from_kind > to_kind` | `gold_pallet_flows` · `flow = moved` | same | — | unit |
| `pallets_shipped` | Pallets removed with reason `shipped` | `gold_pallet_flows` · `flow = removed` | same | DC shipments only (network site stock is not pallet-level) | unit, integration |
| `pallets_shipped_per_hour` | `pallets_shipped` / window length in simulated hours | derived | — | — | — |
| `inventory_units` | Signed unit changes by movement type (receipt, transfer in/out, adjustment) | `gold_inventory_movements` | minute of `occurred_at` | Only `inventory.*` events (Phase 0 commands); operational pallet flows are above | unit |
| `transfers_delivered`, `transfer_pallets_delivered`, `transfer_lead_p50_ms` | Inter-site transfers delivered in the window, their pallets, median `delivered_ms − planned_ms` | `gold_transfers` (new) · `delivered_ms`, `planned_ms`, `pallets` | by delivery time | Network scenario only (empty otherwise) | dbt `assert_transfers_ordered`; integration; captured network fixture matches `pallets_delivered_by_lane` of `network-demo` |
| `transfers_by_lane` | The transfer figures per lane (operator requests have no lane) | same | same | — | integration |
| `series[]` | Per bucket: events, tasks created / completed, orders shipped, pallets created / removed | the above | resolution of §3 | — | web contract test: series sums equal the KPIs |
| `integrity` (whole run) | Events, missing sequence numbers, redelivered copies seen by the pipeline | `gold_simulation_activity` | whole run, not windowed | — | smoke: after a full replay, `redelivered_copies = events` and every KPI unchanged |
| `quality` (whole lake) | `gold_data_quality` checks (conflicting copies, unsupported versions, version gaps, …) | `gold_data_quality` | whole snapshot | Lake-wide, not per run | — |

**Not provided, on purpose:** equipment utilisation and dock occupancy (need interval reconstruction
from status events; not modelled in gold yet), bottleneck detection, and anything measured in wall
clock. They are listed as next increments rather than estimated.

## 5. Freshness and pipeline health (`GET /api/v1/analytics/status`)

| State | When |
|-------|------|
| `empty` | Nothing published yet (200 with an explanation, not an error) |
| `degraded` | Any pipeline problem: no reconciliation yet, the latest reconciliation failed, a component without a healthy heartbeat (older than 120 s or not `ok`), dead letters waiting. The last good snapshot is still served and labelled |
| `stale` | Snapshot older than `WAREHOUSE_ANALYTICS_STALE_AFTER_S` (default 2 h; refresh runs every 30 min) |
| `fresh` | Otherwise |

`freshness.events_recorded_after` counts events stored after the snapshot's source watermark (the
latest bronze ingestion time it includes): data recorded but not yet published.

## 6. What was built

| Part | Files |
|------|-------|
| dbt | `gold_activity_1m`, `gold_transfers`, `run_epoch_ms` / `last_simulation_time_ms` on `gold_simulation_activity`; tests `assert_activity_buckets_match_runs`, `assert_run_epoch_is_constant`, `assert_transfers_ordered` |
| Storage | Alembic `0003_analytics`: `analytics.snapshots`, `snapshot_runs`, `metric_buckets`, `task_facts`, `order_facts`, `transfer_facts`, `quality_checks` (cascade from the snapshot) |
| Pipeline | `warehouse_pipeline/analytics.py`, `warehouse-pipeline publish-analytics [--cleared-by]`; Airflow `publish_analytics` after `reconcile` in the refresh and backfill DAGs (lake pool) |
| API | `warehouse_api/analytics/{schemas,service}.py`, `api/analytics.py` (GET only) |
| Web | Analytics mode (`components/analytics/*`, `lib/analytics/*`): run and window selection, KPI tiles, time charts with hover and table views, breakdowns, lineage; loading, empty, stale, degraded, offline, error and contract-mismatch states. The 3D view stops rendering while it is open; the simulation keeps running |
| Tests | Python unit `test_analytics_units.py`, PostgreSQL `integration/test_analytics.py`; web `analytics.test.ts` (contract against captured real responses); Playwright `analytics.spec.ts` (mocked with captured responses) and `analytics-live.spec.ts` (real API, data-platform job); smoke-test checks after steps 5 and 8 |

## 7. Verification on this branch (Apple M2, macOS)

The developer machine runs the owner's own `warehouse-one` Compose stack (ports 5432/8000/9000/9094
in use, about 2.1 of Docker's 3.8 GiB). It was not touched. Checks ran against throwaway containers
(`w1-p4-pg` on 5446, `w1-p4-minio` on 9010, `w1-p4-kafka` on 9095).

| Check | Command | Result |
|-------|---------|--------|
| TS format, lint, typecheck, unit, build | `pnpm check` | PASS: contracts 26, simulation 154, recorder 10, web 84; build OK |
| Python lint, types | `cd apps/api && uv run ruff check . && uv run ruff format --check . && uv run mypy` | PASS |
| Python unit + PostgreSQL integration | `uv run pytest -m "not kafka"` (PostgreSQL 18 on 5446) | PASS: 109 |
| Kafka/S3 integration | `uv run pytest -m kafka` (throwaway Kafka 4.2.2, MinIO) | PASS: 18 |
| Migrations | `alembic upgrade head`, `downgrade -1`, `upgrade head`, `alembic check` | PASS, no drift |
| dbt build on real bronze | fixtures `operations-demo` + `network-demo` → PostgreSQL → `bronze-rebuild` → `dbt build` | PASS: 78 / 78 (68 before) |
| Publish + API on that gold | `publish` → `/api/v1/analytics/*` | operations-demo: 197 events, 15 tasks by type (load 4, pick 4, putaway 3, relocate 1, unload 3), 1 order, 4 pallets shipped = fixture summary; network-demo: transfers by lane 21/19/3/2 pallets = fixture `pallets_delivered_by_lane` |
| DAG validation | `check_dags.py` in the existing Airflow image with this branch's DAGs mounted read-only | PASS: 3 DAGs, 11 tasks |
| Browser (GPU) | `pnpm --filter @warehouse-one/web build && pnpm test:e2e` | PASS: 40 passed, 2 skipped (`recording`, `analytics-live` need a live API) |
| Browser (CI mode, SwiftShader) | `CI=1 pnpm test:e2e analytics navigation` | PASS: 12 passed (analytics tests 2–15 s each) |
| Data-platform smoke test | `scripts/data-platform-smoke.sh` | **NOT RUN locally**: a second full stack does not fit next to the owner's running stack; it runs in the pull request's CI |

## 8. CI

- PR #9 head `1e51b3a`: run 39970515214, 5/5 jobs green.
- `main` after the merge (`5490c54`): run 39974491437, 5/5 jobs green.
- Follow-up PR #10 merged as `b2ccfdc`: `main` run 40189008788, 5/5 jobs green.

## 9. Limitations

- Snapshots are published by the refresh DAG (every 30 minutes) or a backfill; a recorded run shows
  up after the next successful refresh, never live.
- Sites other than the DC are aggregate models (Phase 5); their stock is not pallet-level, so
  pallet flows describe the DC only. Transfers cover the network.
- Percentiles are exact over the published rows (PostgreSQL `percentile_cont`); with a handful of
  items they are not statistically meaningful, and the dashboard shows counts next to them.
- Retention is the last 20 snapshots; older pinned snapshot ids return 404.
- No authentication on the read API (development stack, like the rest of the API).

## 10. Next increments

1. Equipment utilisation and dock occupancy from status intervals (new gold models + tests).
2. Cross-run comparison (the same metric across runs or scenarios).
3. Alerts on stale or degraded analytics.
4. Bottleneck views once utilisation exists (queue lengths by resource).
