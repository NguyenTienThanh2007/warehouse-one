# Analytics Metrics Catalogue

**Phase:** 4 — Advanced Operations Analytics  
**Status:** Initial source mapping; implementation and API reconciliation are not yet verified.

This catalogue is the contract for any KPI shown by the Phase 4 dashboard. Values must be derived from
the named gold model or a published, reconciled snapshot. The live KPI bar in the 3D view remains
derived from authoritative simulation state and is not replaced by historical analytics.

## Global rules

- **Time basis:** `occurred_at` / `event_date` represent simulated business time. API ingestion,
  processing and publication timestamps represent wall-clock pipeline time. Never mix them silently.
- **Scope:** all initial metrics are scoped to a recorded `simulation_id` and/or the available date
  range. The current event/data model does not yet provide a complete multi-site dimension.
- **No data:** return an explicit empty result and sample count zero; do not manufacture zero-valued
  operational activity when no run was recorded.
- **Freshness:** each API response must expose `as_of` and `snapshot_id`. A recent API heartbeat
  does not prove the gold models are fresh.
- **Delivery duplicates:** bronze intentionally preserves deliveries. Operational counts use the
  deduplicated silver/gold models unless the metric explicitly measures redelivery.
- **Auditability:** every dashboard metric links to its formula, source model, filters and query time.

## Initial metrics

| Metric | Definition | Unit / grain | Source | Notes |
|---|---|---|---|---|
| Events by day and type | Count of distinct deduplicated silver events grouped by simulated `event_date` and `event_type` | events / simulated day / event type | `gold_event_volume_daily` | Not equivalent to orders, pallets or physical throughput |
| Recorded simulation activity | Number of deduplicated events, event types, sequence range, missing sequence count, and simulated span per run | events / run; milliseconds for span | `gold_simulation_activity` | `missing_sequences > 0` is a data-quality issue, not a normal throughput value |
| Orders shipped | Count of orders whose terminal status is `shipped` | orders / selected run or period | `gold_order_fulfilment` | Count orders, not pallets; report cancelled separately |
| Orders cancelled | Count of orders whose terminal status is `cancelled` | orders / selected run or period | `gold_order_fulfilment` | Keep separate from shipped orders |
| Order lead time | `shipped_ms - opened_ms` for shipped orders with both timestamps present | simulated milliseconds / order | `gold_order_fulfilment` | Do not include open/cancelled orders in the shipped lead-time distribution |
| Tasks completed | Count of task rows with terminal status `completed` | tasks / selected run or period | `gold_task_lifecycle` | Show sample count and distinguish open tasks |
| Task wait time | `assigned_ms - created_ms` where both timestamps exist | simulated milliseconds / task | `gold_task_lifecycle` | Missing assignment timestamp means not yet assigned, not zero wait |
| Task service time | `completed_ms - assigned_ms` where both timestamps exist | simulated milliseconds / completed task | `gold_task_lifecycle` | Use completed tasks for duration percentiles |
| Inventory movement | Signed quantity change grouped by location and SKU, split by receipt, transfer-out, transfer-in and adjustment | quantity units / movement side / location / SKU | `gold_inventory_movements` | A transfer produces two movement rows; do not count it as two independent physical transfers |
| Pallet flow | Count pallet created, moved and removed events, optionally grouped by position kind and cause | pallet events / run or simulated period | `gold_pallet_flows` | Event count is not a count of unique pallets unless grouped by pallet identity |
| Redelivered copies | Delivery copies minus distinct deduplicated events | duplicate deliveries / selected scope | `gold_event_volume_daily`, `gold_data_quality` | A non-zero value can be expected after replay; it must not inflate business event counts |
| Rejected/conflicting events | Count of rows by rejection reason in silver rejected events | rejected events / reason | `gold_data_quality` plus source rejected model | Keep unsupported schema and conflicting-copy errors distinguishable |
| Sequence/version quality | Runs with missing sequences and aggregate version steps not equal to one | runs or violations | `gold_data_quality` | A clean value means no detected violation in the published scope, not proof of all business semantics |
| Reconciliation state | Most recent reconciliation report result for the published snapshot | healthy/degraded/failed + timestamp | Phase 3 reconciliation reports | Do not infer this from `/health/ready` alone |

## Deliberately excluded until semantics are proven

- **Equipment utilization:** needs a documented denominator and reliable active/idle/charging state durations. Task assignment counts alone are not utilization.
- **Worker utilization:** workers are not implemented in the current simulation.
- **Physical warehouse throughput per hour:** needs a stable definition of a simulated hour and the relevant unit (orders, pallets or tasks). Do not relabel event volume as throughput.
- **Cross-site transfer time:** requires explicit site identity and inter-site movement events, planned for Phase 5.
- **Space utilization across a network:** current live utilization is facility-state-derived; historical cross-facility utilization requires versioned facility snapshots and site dimensions.

## API response requirements

Any aggregate response should include, where applicable:

- `snapshot_id`: immutable identifier of the published analytics generation;
- `as_of`: wall-clock time the generation was published;
- `time_basis`: `simulated` or `wall_clock`;
- `filters`: normalized run/date filters actually applied;
- `sample_count`: denominator used for averages/percentiles;
- `freshness`: `fresh`, `stale`, `no_recent_input` or `unknown`;
- `source_models`: dbt gold model names used to produce the result.

These fields are proposed contracts; they are not implemented until the Phase 4 API and publication
workflow pass tests.
