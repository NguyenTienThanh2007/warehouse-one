import { z } from "zod";
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

export const SimulationCommand = z.discriminatedUnion("type", [
  ReceiveInventoryCommand,
  MoveInventoryCommand,
  AdjustInventoryCommand,
]);

export type ReceiveInventoryCommand = z.infer<typeof ReceiveInventoryCommand>;
export type MoveInventoryCommand = z.infer<typeof MoveInventoryCommand>;
export type AdjustInventoryCommand = z.infer<typeof AdjustInventoryCommand>;
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
