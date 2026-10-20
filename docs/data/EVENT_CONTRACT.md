# Event & Command Contract

**Source of truth:** `packages/contracts` (Zod). **Published schemas:** `data/schemas/*.schema.json`
(JSON Schema 2020-12, generated with `pnpm schemas:generate`). **Python mirror:**
`apps/api/src/warehouse_api/contracts/events.py`. Drift between them fails CI: the TypeScript test
compares generated vs. committed schemas, and the Python test compares model fields with the schema.

## Envelope

| Field | Type | Semantics |
|-------|------|-----------|
| `event_id` | UUID (v8) | Deterministic: hash of (`simulation_id`, `sequence`). Replays and redeliveries reproduce the same ID, so it is the **idempotency key** downstream. |
| `event_type` | enum | `inventory.received`, `inventory.moved`, `inventory.adjusted` (Phase 0). Discriminates `payload`. |
| `schema_version` | int ≥ 1 | Version of this event type's schema. Registry: `EVENT_PAYLOADS` in `events.ts`. |
| `aggregate_type` | enum | `inventory_item` in Phase 0 (the SKU's warehouse-wide stock). |
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
2. Wall-clock timestamps (`published_at`, `ingested_at`, `processed_at`) are **added by the
   publisher and consumers** (Phase 3). The simulation never reads a clock (enforced by lint rule
   and tests).
3. Across runs there is no global order. Partition by `simulation_id` (Kafka key in Phase 3) so a
   run's events stay ordered within one partition.

### Delivery semantics (target, Phase 3)

At-least-once delivery from an outbox, with idempotent consumers deduplicating on `event_id` and
validating `aggregate_version` continuity. We will **not** claim end-to-end exactly-once. We will
claim "effectively-once results" only where tests demonstrate duplicate- and replay-safe outputs.

## Payloads (schema_version 1)

```text
inventory.received  { location_id, sku, quantity>0, location_quantity_after>=0 }
inventory.moved     { from_location_id, to_location_id, sku, quantity>0 }
inventory.adjusted  { location_id, sku, delta!=0, reason: cycle_count|damage|correction, location_quantity_after>=0 }
```

## Commands

Commands are *requests* that may be rejected. Each is validated at the trust boundary
(`parseCommand`, never throws) and again inside `step()`. Phase 0 commands are
`inventory.receive`, `inventory.move` and `inventory.adjust`. The rejection codes are
`INVALID_COMMAND`, `UNKNOWN_LOCATION`, `UNKNOWN_SKU`, `INSUFFICIENT_STOCK` and `CAPACITY_EXCEEDED`.
Rejections are returned to the caller and are not domain events. Only facts become events.

## Schema evolution policy

- **Additive and optional changes** (a new optional payload field) keep `schema_version`.
  Consumers must ignore unknown *optional* fields once Phase 3 relaxes strictness at the bronze layer.
- **Breaking changes** (rename, type change, new required field) bump `schema_version` for that
  event type. Producers emit only the newest version. Consumers and dbt silver models handle every
  version still present in the lake.
- New event types are additive. Each Phase 2 type (`order.*`, `forklift.*`, `truck.*`, `worker.*`)
  is added with its payload schema, golden fixture coverage and a Python mirror in the same change.

## Fixtures

`data/fixtures/foundation-demo/` contains a deterministic reference run: the config, the scripted
commands (including three deliberately invalid ones), 150 events and a summary with final totals
and the state hash. It is regenerated with `pnpm fixtures:generate` and guarded by a golden-file
test. Python tests validate every event against the JSON Schema and Pydantic, and reconcile the
folded events with the simulation's final totals. That is the same reconciliation the Phase 3
pipeline will automate.
