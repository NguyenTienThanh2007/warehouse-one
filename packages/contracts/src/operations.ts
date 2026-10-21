import { z } from "zod";
import { EntityId } from "./primitives";

/**
 * Operational vocabulary shared by commands, events and the simulation (Phase 2).
 * Every pallet is exactly one inventory unit and always has exactly one position.
 */

/** Pallets per truck (13.6 m trailer, two rows of 13 EUR/ISO pallets). */
export const TRUCK_CAPACITY = 26;

export const PalletPosition = z.discriminatedUnion("kind", [
  /** A rack position: `slot` = level × positions_per_level + column (level 0 is the floor). */
  z.object({ kind: z.literal("slot"), location_id: EntityId, slot: z.int().nonnegative() }),
  /** A marked staging position in a dock's lane (0 = nearest the door). */
  z.object({ kind: z.literal("staging"), dock_id: EntityId, position: z.int().nonnegative() }),
  /** On the forks of a material-handling vehicle. */
  z.object({ kind: z.literal("equipment"), equipment_id: EntityId }),
  /** Inside a truck's trailer. */
  z.object({ kind: z.literal("truck"), truck_id: EntityId, position: z.int().nonnegative() }),
]);
export type PalletPosition = z.infer<typeof PalletPosition>;

export const EQUIPMENT_STATUSES = ["idle", "travelling", "handling", "charging"] as const;
export const EquipmentStatus = z.enum(EQUIPMENT_STATUSES);
export type EquipmentStatus = z.infer<typeof EquipmentStatus>;

export const TASK_TYPES = ["relocate", "putaway", "pick", "load", "unload"] as const;
export const TaskType = z.enum(TASK_TYPES);
export type TaskType = z.infer<typeof TaskType>;

export const TRUCK_STATUSES = ["yard", "docking", "docked", "departing", "departed"] as const;
export const TruckStatus = z.enum(TRUCK_STATUSES);
export type TruckStatus = z.infer<typeof TruckStatus>;

export const TruckDirection = z.enum(["inbound", "outbound"]);
export type TruckDirection = z.infer<typeof TruckDirection>;

export const ORDER_STATUSES = ["open", "in_progress", "shipped", "cancelled"] as const;
export const OrderStatus = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatus>;

// ---------------------------------------------------------------------------------------------
// Phase 5 logistics network: sites connected by roads, line-haul trucks, inter-site transfers.

/**
 * A transfer moves pallets from one site to another on one line-haul truck.
 * planned → assigned (truck chosen) → loading → in_transit → unloading → delivered, or cancelled.
 */
export const TRANSFER_STATUSES = [
  "planned",
  "assigned",
  "loading",
  "in_transit",
  "unloading",
  "delivered",
  "cancelled",
] as const;
export const TransferStatus = z.enum(TRANSFER_STATUSES);
export type TransferStatus = z.infer<typeof TransferStatus>;

/**
 * Line-haul truck activity. `at_dc` means the truck is inside the distribution centre's own yard
 * and dock simulation; `off_network` means it is outside the modelled world (beyond the gateway).
 */
export const LINEHAUL_STATUSES = [
  "parked",
  "driving",
  "docking",
  "loading",
  "unloading",
  "waiting",
  "undocking",
  "at_dc",
  "off_network",
  "servicing",
] as const;
export const LinehaulStatus = z.enum(LINEHAUL_STATUSES);
export type LinehaulStatus = z.infer<typeof LinehaulStatus>;

/** A quantity of one SKU, in pallets. */
export const CargoLine = z.object({
  sku: EntityId,
  quantity: z.int().positive().max(TRUCK_CAPACITY),
});
export type CargoLine = z.infer<typeof CargoLine>;

/** 1–8 lines whose quantities fit one truck; each SKU appears once. */
export const CargoLines = z
  .array(CargoLine)
  .min(1)
  .max(8)
  .refine((lines) => lines.reduce((n, l) => n + l.quantity, 0) <= TRUCK_CAPACITY, {
    message: `total quantity must not exceed ${TRUCK_CAPACITY} pallets (one truck)`,
  })
  .refine((lines) => new Set(lines.map((l) => l.sku)).size === lines.length, {
    message: "each SKU may appear only once",
  });
