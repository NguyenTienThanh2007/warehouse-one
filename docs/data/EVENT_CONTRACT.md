# Event & Command Contract

**Source of truth:** `packages/contracts` (Zod). **Published schemas:** `data/schemas/*.schema.json`
(JSON Schema 2020-12, generated with `pnpm schemas:generate`). **Python mirror:**
`apps/api/src/warehouse_api/contracts/events.py`. Drift between them fails CI: the TypeScript test
compares generated vs. committed schemas, and the Python test compares model fields with the schema.

## Envelope

| Field | Type | Semantics |
|-------|------|-----------|
| `event_id` | UUID (v8) | Deterministic: hash of (`simulation_id`, `sequence`). Replays and redeliveries reproduce the same ID, so it is the **idempotency key** downstream. |
| `event_type` | enum | 13 types (Phase 0: `inventory.*`; Phase 2: `pallet.*`, `task.*`, `equipment.status_changed`, `truck.status_changed`, `order.status_changed`). Discriminates `payload`. |
| `schema_version` | int ≥ 1 | Version of this event type's schema. Registry: `EVENT_PAYLOADS` in `events.ts`. |
| `aggregate_type` | enum | `inventory_item`, `pallet`, `task`, `equipment`, `truck`, `order` (fixed per event type). |
| `aggregate_id` | slug | The aggregate instance (SKU id). |
| `aggregate_version` | int ≥ 1 | Strictly +1 per aggregate. Gaps or regressions downstream mean lost or out-of-order events. |
| `simulation_id` | UUID | The run that produced the event. |
| `sequence` | int ≥ 1 | Gap-free, strictly increasing per `simulation_id`. **The total order of a run.** |
| `occurred_at` | ISO-8601 UTC, ms | `epoch + simulation_time_ms`. Deterministic: it is *simulated* business time, not wall-clock. |
| `simulation_time_ms` | int ≥ 0 | Simulated milliseconds since the run's epoch, always a multiple of `tick_ms`. |
| `correlation_id` | string | The originating request: the command ID, or `sys-workload-t<tick>` for system activity. |
| `causation_id` | string | The direct cause: a command ID, or a system name such as `system:synthetic-workload`. |
| `payload` | object | Event-type specific and strict (no unknown fields). |

### Time and ordering rules

1. Order within a run is `sequence`. Consumers must not order by `occurred_at`, because several
   events share a tick.
2. Wall-clock timestamps are **operational metadata added outside the event**: `recorded_at`
   (API), `published_at` (relay), `first_processed_at` (ledger), `ingested_at` (bronze). They live
   in separate columns and never inside the envelope. The simulation never reads a clock (enforced
   by lint rule and tests).
3. Across runs there is no global order. The Kafka key is `simulation_id`, so a run's events stay
   in one partition, in the order the relay published them, which is `sequence` order (DEC-025).

## Ingestion, delivery and replay (Phase 3)

### Ingestion boundary (DEC-024)

Producers (the web app's opt-in recorder, the headless `pnpm sim:record`) send a run to the API:
`PUT /api/v1/simulations/{id}` registers its config and engine version; `POST …/batches` sends
commands and events. Each batch is stored in **one PostgreSQL transaction** with its outbox rows.

| The API validates (rejects with 4xx otherwise) | The API trusts |
|-----------------------------------------------|----------------|
| Envelope and payload against this contract (strict JSON types) | That the events are what the TypeScript engine produced for the registered config and command log |
| `event_id` = deterministic ID of (`simulation_id`, `sequence`) | |
| `occurred_at` = epoch + `simulation_time_ms`, a tick multiple | |
| Gap-free `sequence` from the run's last stored event; simulated time never goes back | |
| `aggregate_version` continues each aggregate by exactly +1 | |
| Command shapes; no new commands for ticks already recorded | |

The trust is checked after the fact by `pnpm sim:verify`, which replays the stored config and
command log in the engine and compares every stored event (canonical JSON).

**Retries and duplicates at the API:** a retried batch with the same `batch_id` and content
returns the original result (200, `replayed: true`); the same `batch_id` with different content
is `409 BATCH_ID_REUSED`. Events already stored are accepted again only if byte-identical (counted
as duplicates); the same `sequence` with different content is `409 CONFLICTING_EVENT`.

### Delivery (DEC-025, DEC-026, DEC-027)

**At least once**, end to end. Nothing here is exactly-once:

- The relay marks an outbox row published only after the broker acknowledged it. A crash in
  between republishes the row.
- Consumers commit offsets only after their durable work. A crash in between reprocesses the batch.

Results are **effectively once** where tests prove it:

| Layer | How duplicates are handled | Evidence |
|-------|---------------------------|----------|
| Ledger (`pipeline.consumer_events`) | primary key (`consumer_group`, `event_id`); a redelivery increments `delivery_count` | redelivery and crash-before-commit tests; smoke step 8 |
| Bronze (Parquet) | **keeps every delivery** (audit trail); the same offset range rewrites the same object key | bronze redelivery test |
| Silver / gold (dbt) | `silver_events` keeps one row per `event_id`; copies must be byte-identical | dbt tests; smoke step 8 (gold unchanged after replaying a whole run) |

### Ordering and version rules (ledger consumer)

| Situation | Outcome |
|-----------|---------|
| new `event_id`, `aggregate_version` = last + 1 | processed |
| same `event_id`, identical envelope | duplicate: skipped, `delivery_count` + 1 |
| same `event_id`, different envelope | dead letter `conflicting_duplicate` |
| new `event_id`, `aggregate_version` ≤ last | dead letter `aggregate_version_regression` |
| `aggregate_version` > last + 1, or `sequence` > last + 1 | processed, data-quality issue recorded |

### Dead letters

Undecodable messages, contract violations and the cases above are dead-lettered. They are never
dropped:

- **Kafka:** written to `warehouse.domain-events.v1.dlq` with the original bytes (base64), source
  topic/partition/offset, `event_id` if parseable, error class and detail.
- **PostgreSQL:** written to `pipeline.dead_letters`, unique per source offset.

Infrastructure failures (database, object store) are **not** dead-lettered. The consumer retries
with bounded backoff, then rewinds to its last committed offsets and tries again later.
Reconciliation fails while any dead letter is in scope.

### Replay and rebuild

- **Re-publishing a run** (`warehouse-pipeline replay --simulation <id>`) produces its stored events
  again. The ledger counts them as redeliveries and gold does not change.
- **Rebuilding bronze for a simulated date range** (`warehouse-pipeline bronze-rebuild`, or the
  `warehouse_lake_backfill` DAG) reads PostgreSQL directly and writes deterministic objects. Silver
  deduplicates them against the Kafka copies.
- **Replaying a run in the engine** (`pnpm sim:verify`) regenerates its events from the config and
  command log.

## Payloads (schema_version 1)

```text
inventory.received       { location_id, sku, quantity>0, location_quantity_after>=0 }
inventory.moved          { from_location_id, to_location_id, sku, quantity>0 }
inventory.adjusted       { location_id, sku, delta!=0, reason: cycle_count|damage|correction, location_quantity_after>=0 }
pallet.created           { pallet_id, sku, at: position, cause: receive|inbound_truck|adjust }
pallet.moved             { pallet_id, sku, from: position, to: position, task_id }
pallet.removed           { pallet_id, sku, from: position, reason: adjust|shipped }
task.created             { task_id, task_type: relocate|putaway|pick|load|unload, pallet_id, sku, from, to, order_id, truck_id }
task.assigned            { task_id, equipment_id, route_length_mm }
task.completed           { task_id, equipment_id, duration_ticks }
task.cancelled           { task_id, reason: order_cancelled }
equipment.status_changed { equipment_id, from, to, node_id, task_id, battery_permille }
truck.status_changed     { truck_id, direction: inbound|outbound, from, to, dock_id, pallet_count }
order.status_changed     { order_id, from, to, truck_id, lines }
position = slot{location_id, slot} | staging{dock_id, position} | equipment{equipment_id} | truck{truck_id, position}
```

## Commands

Commands are *requests* that may be rejected. Each is validated at the trust boundary
(`parseCommand`, never throws) and again inside `step()`. Commands: `inventory.receive`,
`inventory.move`, `inventory.adjust`, `truck.schedule_inbound`, `order.create`, `order.cancel`,
`pallet.relocate`. Rejections are returned to the caller and are not domain events. Only facts
become events.

A run's **command log** (`{tick, command}` in application order, including rejected commands,
because they were inputs) is stored by the API and is the replay input. Its Python mirror
(`contracts/commands.py`) is drift-tested against `data/schemas/simulation-command.schema.json`.

## Schema evolution policy

- **Additive and optional changes** (a new optional payload field) keep `schema_version`.
  Consumers must ignore unknown *optional* fields once Phase 3 relaxes strictness at the bronze layer.
- **Breaking changes** (rename, type change, new required field) bump `schema_version` for that
  event type. Producers emit only the newest version. Consumers and dbt silver models handle every
  version still present in the lake.
- New event types are additive. Each is added with its payload schema, fixture coverage and a
  Python mirror in the same change.
- **dbt silver** accepts only the `(event_type, schema_version)` pairs listed in
  `analytics/dbt_project.yml` (`supported_versions`). Any other pair is listed in
  `silver_rejected_events`, and the reconciliation fails on it, so a new version cannot be dropped
  silently.

## Fixtures

- **`data/fixtures/foundation-demo/`** (Phase 0) contains:
  - a deterministic reference run with its config;
  - the scripted commands, including three deliberately invalid ones;
  - 150 events;
  - a summary with final totals and the state hash.
- **`data/fixtures/operations-demo/`** (Phase 2) is the operational reference run.
- **Regeneration:** both are regenerated with `pnpm fixtures:generate` and guarded by golden-file
  tests.
- **Python tests** validate every event against the JSON Schema and Pydantic, and recompute every
  `event_id` with the Python port of the deterministic ID. The API integration tests ingest the
  operations fixture end to end.
