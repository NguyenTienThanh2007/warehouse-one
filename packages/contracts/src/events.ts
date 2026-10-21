import { z } from "zod";
import {
  CargoLine,
  EquipmentStatus,
  LinehaulStatus,
  OrderStatus,
  PalletPosition,
  TaskType,
  TransferStatus,
  TruckDirection,
  TruckStatus,
} from "./operations";
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

// ---------------------------------------------------------------------------------------------
// Phase 2 operational events.

const NodeId = z.string().min(1).max(64);

export const PalletCreatedPayload = z.object({
  pallet_id: EntityId,
  sku: EntityId,
  at: PalletPosition,
  cause: z.enum(["receive", "inbound_truck", "adjust"]),
});

export const PalletMovedPayload = z.object({
  pallet_id: EntityId,
  sku: EntityId,
  from: PalletPosition,
  to: PalletPosition,
  /** The task that moved it, or null for an administrative move (`inventory.move`). */
  task_id: EntityId.nullable(),
});

export const PalletRemovedPayload = z.object({
  pallet_id: EntityId,
  sku: EntityId,
  from: PalletPosition,
  reason: z.enum(["adjust", "shipped"]),
});

export const TaskCreatedPayload = z.object({
  task_id: EntityId,
  task_type: TaskType,
  pallet_id: EntityId,
  sku: EntityId,
  from: PalletPosition,
  to: PalletPosition,
  order_id: EntityId.nullable(),
  truck_id: EntityId.nullable(),
});

export const TaskAssignedPayload = z.object({
  task_id: EntityId,
  equipment_id: EntityId,
  /** Planned travel to the pick-up point at assignment time. */
  route_length_mm: z.int().nonnegative(),
});

export const TaskCompletedPayload = z.object({
  task_id: EntityId,
  equipment_id: EntityId,
  /** Ticks from creation to completion. */
  duration_ticks: z.int().nonnegative(),
});

export const TaskCancelledPayload = z.object({
  task_id: EntityId,
  reason: z.enum(["order_cancelled"]),
});

export const EquipmentStatusChangedPayload = z.object({
  equipment_id: EntityId,
  from: EquipmentStatus,
  to: EquipmentStatus,
  node_id: NodeId,
  task_id: EntityId.nullable(),
  battery_permille: z.int().min(0).max(1000),
});

export const TruckStatusChangedPayload = z.object({
  truck_id: EntityId,
  direction: TruckDirection,
  /** null when the truck is first scheduled. */
  from: TruckStatus.nullable(),
  to: TruckStatus,
  dock_id: EntityId.nullable(),
  pallet_count: z.int().nonnegative(),
});

export const OrderStatusChangedPayload = z.object({
  order_id: EntityId,
  /** null when the order is created. */
  from: OrderStatus.nullable(),
  to: OrderStatus,
  truck_id: EntityId,
  lines: z.array(CargoLine),
});

// ---------------------------------------------------------------------------------------------
// Phase 5 logistics-network events.

export const TransferStatusChangedPayload = z.object({
  transfer_id: EntityId,
  /** The scheduled lane that created it, or null for an operator request (`transfer.request`). */
  lane_id: EntityId.nullable(),
  from_site_id: EntityId,
  to_site_id: EntityId,
  /** null when the transfer is planned. */
  from: TransferStatus.nullable(),
  to: TransferStatus,
  vehicle_id: EntityId.nullable(),
  lines: z.array(CargoLine),
});

export const LinehaulStatusChangedPayload = z.object({
  vehicle_id: EntityId,
  from: LinehaulStatus,
  to: LinehaulStatus,
  /** Road node the truck is at or last passed. */
  node_id: NodeId,
  /** Site the truck is at, or null on the road. */
  site_id: EntityId.nullable(),
  transfer_id: EntityId.nullable(),
  /** Total distance driven on the road network since the run started. */
  odometer_m: z.int().nonnegative(),
});

export const SiteStockChangedPayload = z.object({
  site_id: EntityId,
  /** Pallets are counted per SKU; containers (terminal only) have no SKU. */
  unit: z.enum(["pallet", "container"]),
  sku: EntityId.nullable(),
  delta: z.int().refine((d) => d !== 0, "delta must be non-zero"),
  quantity_after: z.int().nonnegative(),
  reason: z.enum(["loaded", "unloaded", "devanned", "vessel_discharge"]),
  transfer_id: EntityId.nullable(),
});

/** Registry: event_type -> payload schema, schema version and aggregate type. */
export const EVENT_PAYLOADS = {
  "inventory.received": {
    schema: InventoryReceivedPayload,
    version: 1,
    aggregate: "inventory_item",
  },
  "inventory.moved": { schema: InventoryMovedPayload, version: 1, aggregate: "inventory_item" },
  "inventory.adjusted": {
    schema: InventoryAdjustedPayload,
    version: 1,
    aggregate: "inventory_item",
  },
  "pallet.created": { schema: PalletCreatedPayload, version: 1, aggregate: "pallet" },
  "pallet.moved": { schema: PalletMovedPayload, version: 1, aggregate: "pallet" },
  "pallet.removed": { schema: PalletRemovedPayload, version: 1, aggregate: "pallet" },
  "task.created": { schema: TaskCreatedPayload, version: 1, aggregate: "task" },
  "task.assigned": { schema: TaskAssignedPayload, version: 1, aggregate: "task" },
  "task.completed": { schema: TaskCompletedPayload, version: 1, aggregate: "task" },
  "task.cancelled": { schema: TaskCancelledPayload, version: 1, aggregate: "task" },
  "equipment.status_changed": {
    schema: EquipmentStatusChangedPayload,
    version: 1,
    aggregate: "equipment",
  },
  "truck.status_changed": { schema: TruckStatusChangedPayload, version: 1, aggregate: "truck" },
  "order.status_changed": { schema: OrderStatusChangedPayload, version: 1, aggregate: "order" },
  "transfer.status_changed": {
    schema: TransferStatusChangedPayload,
    version: 1,
    aggregate: "transfer",
  },
  "linehaul.status_changed": {
    schema: LinehaulStatusChangedPayload,
    version: 1,
    aggregate: "linehaul",
  },
  "site.stock_changed": { schema: SiteStockChangedPayload, version: 1, aggregate: "site" },
} as const;

export type EventType = keyof typeof EVENT_PAYLOADS;
export type AggregateType = (typeof EVENT_PAYLOADS)[EventType]["aggregate"];
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[];

function envelope<A extends string>(aggregate: A) {
  return {
    event_id: Uuid,
    schema_version: z.int().positive(),
    aggregate_type: z.literal(aggregate),
    aggregate_id: EntityId,
    aggregate_version: z.int().positive(),
    simulation_id: Uuid,
    sequence: z.int().positive(),
    occurred_at: z.iso.datetime({ offset: false, precision: 3 }),
    simulation_time_ms: z.int().nonnegative(),
    correlation_id: z.string().min(1).max(128),
    causation_id: z.string().min(1).max(128),
  };
}

function eventSchema<T extends EventType, P extends z.ZodType>(type: T, payload: P) {
  return z.object({
    ...envelope(EVENT_PAYLOADS[type].aggregate),
    event_type: z.literal(type),
    payload,
  });
}

export const InventoryReceivedEvent = eventSchema("inventory.received", InventoryReceivedPayload);
export const InventoryMovedEvent = eventSchema("inventory.moved", InventoryMovedPayload);
export const InventoryAdjustedEvent = eventSchema("inventory.adjusted", InventoryAdjustedPayload);
export const PalletCreatedEvent = eventSchema("pallet.created", PalletCreatedPayload);
export const PalletMovedEvent = eventSchema("pallet.moved", PalletMovedPayload);
export const PalletRemovedEvent = eventSchema("pallet.removed", PalletRemovedPayload);
export const TaskCreatedEvent = eventSchema("task.created", TaskCreatedPayload);
export const TaskAssignedEvent = eventSchema("task.assigned", TaskAssignedPayload);
export const TaskCompletedEvent = eventSchema("task.completed", TaskCompletedPayload);
export const TaskCancelledEvent = eventSchema("task.cancelled", TaskCancelledPayload);
export const EquipmentStatusChangedEvent = eventSchema(
  "equipment.status_changed",
  EquipmentStatusChangedPayload,
);
export const TruckStatusChangedEvent = eventSchema(
  "truck.status_changed",
  TruckStatusChangedPayload,
);
export const OrderStatusChangedEvent = eventSchema(
  "order.status_changed",
  OrderStatusChangedPayload,
);

export const TransferStatusChangedEvent = eventSchema(
  "transfer.status_changed",
  TransferStatusChangedPayload,
);
export const LinehaulStatusChangedEvent = eventSchema(
  "linehaul.status_changed",
  LinehaulStatusChangedPayload,
);
export const SiteStockChangedEvent = eventSchema("site.stock_changed", SiteStockChangedPayload);

export const DomainEvent = z.discriminatedUnion("event_type", [
  InventoryReceivedEvent,
  InventoryMovedEvent,
  InventoryAdjustedEvent,
  PalletCreatedEvent,
  PalletMovedEvent,
  PalletRemovedEvent,
  TaskCreatedEvent,
  TaskAssignedEvent,
  TaskCompletedEvent,
  TaskCancelledEvent,
  EquipmentStatusChangedEvent,
  TruckStatusChangedEvent,
  OrderStatusChangedEvent,
  TransferStatusChangedEvent,
  LinehaulStatusChangedEvent,
  SiteStockChangedEvent,
]);

export type InventoryReceivedEvent = z.infer<typeof InventoryReceivedEvent>;
export type InventoryMovedEvent = z.infer<typeof InventoryMovedEvent>;
export type InventoryAdjustedEvent = z.infer<typeof InventoryAdjustedEvent>;
export type DomainEvent = z.infer<typeof DomainEvent>;
export type EventPayload<T extends EventType> = Extract<DomainEvent, { event_type: T }>["payload"];
