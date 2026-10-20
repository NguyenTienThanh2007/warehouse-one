import { z } from "zod";
import { EntityId, Quantity, Uuid } from "./primitives";

/**
 * Domain events are immutable facts emitted by the authoritative simulation.
 * Wire format is snake_case JSON so it maps 1:1 onto Kafka messages, Parquet columns and dbt models.
 *
 * Ordering & time semantics (see docs/data/EVENT_CONTRACT.md):
 * - `sequence` is gap-free and strictly increasing per `simulation_id`. It is the total order.
 * - `aggregate_version` is strictly increasing per (`aggregate_type`, `aggregate_id`) and supports
 *   optimistic concurrency / out-of-order detection downstream.
 * - `simulation_time_ms` is simulated time since the run's epoch. `occurred_at` is that same
 *   instant expressed as UTC (`epoch + simulation_time_ms`), so both are deterministic.
 *   Wall-clock ingestion timestamps are added by the publisher/consumers, never by the simulation.
 */

export const InventoryReceivedPayload = z.object({
  location_id: EntityId,
  sku: EntityId,
  quantity: Quantity,
  location_quantity_after: z.int().nonnegative(),
});

export const InventoryMovedPayload = z.object({
  from_location_id: EntityId,
  to_location_id: EntityId,
  sku: EntityId,
  quantity: Quantity,
});

export const InventoryAdjustedPayload = z.object({
  location_id: EntityId,
  sku: EntityId,
  delta: z.int(),
  reason: z.enum(["cycle_count", "damage", "correction"]),
  location_quantity_after: z.int().nonnegative(),
});

/** Registry: event_type -> { payload schema, payload schema version }. */
export const EVENT_PAYLOADS = {
  "inventory.received": { schema: InventoryReceivedPayload, version: 1 },
  "inventory.moved": { schema: InventoryMovedPayload, version: 1 },
  "inventory.adjusted": { schema: InventoryAdjustedPayload, version: 1 },
} as const;

export type EventType = keyof typeof EVENT_PAYLOADS;
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[];

const envelopeFields = {
  event_id: Uuid,
  schema_version: z.int().positive(),
  aggregate_type: z.enum(["inventory_item"]),
  aggregate_id: EntityId,
  aggregate_version: z.int().positive(),
  simulation_id: Uuid,
  sequence: z.int().positive(),
  occurred_at: z.iso.datetime({ offset: false, precision: 3 }),
  simulation_time_ms: z.int().nonnegative(),
  correlation_id: z.string().min(1).max(128),
  causation_id: z.string().min(1).max(128),
};

export const InventoryReceivedEvent = z.object({
  ...envelopeFields,
  event_type: z.literal("inventory.received"),
  payload: InventoryReceivedPayload,
});
export const InventoryMovedEvent = z.object({
  ...envelopeFields,
  event_type: z.literal("inventory.moved"),
  payload: InventoryMovedPayload,
});
export const InventoryAdjustedEvent = z.object({
  ...envelopeFields,
  event_type: z.literal("inventory.adjusted"),
  payload: InventoryAdjustedPayload,
});

export const DomainEvent = z.discriminatedUnion("event_type", [
  InventoryReceivedEvent,
  InventoryMovedEvent,
  InventoryAdjustedEvent,
]);

export type InventoryReceivedEvent = z.infer<typeof InventoryReceivedEvent>;
export type InventoryMovedEvent = z.infer<typeof InventoryMovedEvent>;
export type InventoryAdjustedEvent = z.infer<typeof InventoryAdjustedEvent>;
export type DomainEvent = z.infer<typeof DomainEvent>;
export type EventPayload<T extends EventType> = Extract<DomainEvent, { event_type: T }>["payload"];
