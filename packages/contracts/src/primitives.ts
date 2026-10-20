import { z } from "zod";

/** Stable identifiers are lowercase, human-readable slugs: `loc-a01`, `sku-pallet-std`. */
export const EntityId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "must be a lowercase slug (a-z, 0-9, '-'), max 64 chars");
export type EntityId = z.infer<typeof EntityId>;

/** RFC 9562 UUID string (the simulation emits deterministic version-8 UUIDs). */
export const Uuid = z.uuid();

/** Positive whole units. Inventory is counted, never fractional. */
export const Quantity = z.int().positive().max(1_000_000);
