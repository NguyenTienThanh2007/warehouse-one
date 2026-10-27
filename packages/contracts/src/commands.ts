import { z } from "zod";
import { CargoLines } from "./operations";
import { EntityId, Quantity } from "./primitives";

/**
 * Commands are requests to change simulation state. They may be rejected.
 * Every command is validated with these schemas at the trust boundary (UI, API, AI proposals)
 * before it reaches the simulation.
 */
const CommandBase = z.object({
  command_id: z.string().min(1).max(128),
});

export const ReceiveInventoryCommand = CommandBase.extend({
  type: z.literal("inventory.receive"),
  payload: z.object({ location_id: EntityId, sku: EntityId, quantity: Quantity }),
});

export const MoveInventoryCommand = CommandBase.extend({
  type: z.literal("inventory.move"),
  payload: z
    .object({
      from_location_id: EntityId,
      to_location_id: EntityId,
      sku: EntityId,
      quantity: Quantity,
    })
    .refine((p) => p.from_location_id !== p.to_location_id, {
      message: "from_location_id and to_location_id must differ",
    }),
});

export const AdjustInventoryCommand = CommandBase.extend({
  type: z.literal("inventory.adjust"),
  payload: z.object({
    location_id: EntityId,
    sku: EntityId,
    delta: z
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((d) => d !== 0, "delta must be non-zero"),
    reason: z.enum(["cycle_count", "damage", "correction"]),
  }),
});

/** Phase 2: schedule an inbound truck carrying new pallets; it is unloaded and put away. */
export const ScheduleInboundTruckCommand = CommandBase.extend({
  type: z.literal("truck.schedule_inbound"),
  payload: z.object({ cargo: CargoLines }),
});

/** Phase 2: create an outbound order; stock is allocated now, then picked, staged and loaded. */
export const CreateOrderCommand = CommandBase.extend({
  type: z.literal("order.create"),
  payload: z.object({ lines: CargoLines }),
});

/** Phase 2: cancel an order that has not started (no dock assigned yet). */
export const CancelOrderCommand = CommandBase.extend({
  type: z.literal("order.cancel"),
  payload: z.object({ order_id: EntityId }),
});

/** Phase 2: move one stored pallet to another rack bay with a forklift. */
export const RelocatePalletCommand = CommandBase.extend({
  type: z.literal("pallet.relocate"),
  payload: z.object({ pallet_id: EntityId, to_location_id: EntityId }),
});

/**
 * Phase 5: ask the logistics network to move pallets between two sites on a line-haul truck. The
 * engine plans it like a scheduled transfer (stock and capacity are reserved), or rejects it.
 */
export const RequestTransferCommand = CommandBase.extend({
  type: z.literal("transfer.request"),
  payload: z
    .object({ from_site_id: EntityId, to_site_id: EntityId, lines: CargoLines })
    .refine((p) => p.from_site_id !== p.to_site_id, {
      message: "from_site_id and to_site_id must differ",
    }),
});

/**
 * Phase 6: where a line-haul truck waits while it has no work. `site_id` names a site with staging
 * stalls (the truck waits on one of them); null sends it back to its home stall at the fleet
 * depot. The engine keeps one staging stall per site free for arriving trucks.
 */
export const SetStandbyCommand = CommandBase.extend({
  type: z.literal("linehaul.set_standby"),
  payload: z.object({ vehicle_id: EntityId, site_id: EntityId.nullable() }),
});

export const SimulationCommand = z.discriminatedUnion("type", [
  ReceiveInventoryCommand,
  MoveInventoryCommand,
  AdjustInventoryCommand,
  ScheduleInboundTruckCommand,
  CreateOrderCommand,
  CancelOrderCommand,
  RelocatePalletCommand,
  RequestTransferCommand,
  SetStandbyCommand,
]);

export type ReceiveInventoryCommand = z.infer<typeof ReceiveInventoryCommand>;
export type MoveInventoryCommand = z.infer<typeof MoveInventoryCommand>;
export type AdjustInventoryCommand = z.infer<typeof AdjustInventoryCommand>;
export type ScheduleInboundTruckCommand = z.infer<typeof ScheduleInboundTruckCommand>;
export type CreateOrderCommand = z.infer<typeof CreateOrderCommand>;
export type CancelOrderCommand = z.infer<typeof CancelOrderCommand>;
export type RelocatePalletCommand = z.infer<typeof RelocatePalletCommand>;
export type RequestTransferCommand = z.infer<typeof RequestTransferCommand>;
export type SetStandbyCommand = z.infer<typeof SetStandbyCommand>;
export type SimulationCommand = z.infer<typeof SimulationCommand>;
export type SimulationCommandType = SimulationCommand["type"];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Validate an untrusted value as a simulation command. Never throws. */
export function parseCommand(input: unknown): ParseResult<SimulationCommand> {
  const result = SimulationCommand.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}
