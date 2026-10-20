import type { LocationConfig, LoggedCommand, SimulationConfig } from "../types";

export const FOUNDATION_DEMO_SIMULATION_ID = "6c0b7c8e-2f43-4a59-9a3e-5d1f0c2b7a10";

/**
 * Small reference layout used by the Phase 0 diagnostic view, golden fixtures and benchmarks:
 * `aisles` rows of `bays` storage locations with 8 pallet positions each.
 */
export function createFoundationDemoConfig(
  overrides: Partial<Pick<SimulationConfig, "seed" | "simulation_id">> & {
    aisles?: number;
    bays?: number;
  } = {},
): SimulationConfig {
  const aisles = overrides.aisles ?? 2;
  const bays = overrides.bays ?? 12;
  const locations: LocationConfig[] = [];
  for (let a = 0; a < aisles; a++) {
    const zone = `zone-${String.fromCharCode(97 + (a % 26))}`;
    for (let b = 0; b < bays; b++) {
      locations.push({
        id: `loc-${String(a).padStart(2, "0")}-${String(b + 1).padStart(3, "0")}`,
        zone,
        capacity: 8,
        position: { x: (b - (bays - 1) / 2) * 2.8, z: (a - (aisles - 1) / 2) * 6 },
      });
    }
  }
  return {
    simulation_id: overrides.simulation_id ?? FOUNDATION_DEMO_SIMULATION_ID,
    seed: overrides.seed ?? "warehouse-one-foundation",
    tick_ms: 100,
    epoch: "2026-01-05T06:00:00.000Z",
    locations,
    skus: [
      { id: "sku-std-pallet", name: "Standard pallet (mixed goods)" },
      { id: "sku-cold-chain", name: "Cold-chain pallet" },
      { id: "sku-bulk-bags", name: "Bulk bags" },
      { id: "sku-electronics", name: "Boxed electronics" },
    ],
    synthetic_workload: { inbound_probability: 0.2, move_probability: 0.15, max_quantity: 3 },
  };
}

/** Scripted operator commands for the golden fixture, including deliberately invalid ones. */
export const FOUNDATION_DEMO_SCRIPT: readonly LoggedCommand[] = [
  {
    tick: 1,
    command: {
      command_id: "op-0001",
      type: "inventory.receive",
      payload: { location_id: "loc-00-001", sku: "sku-std-pallet", quantity: 6 },
    },
  },
  {
    tick: 1,
    command: {
      command_id: "op-0002",
      type: "inventory.receive",
      payload: { location_id: "loc-00-001", sku: "sku-cold-chain", quantity: 4 },
    },
  }, // CAPACITY_EXCEEDED (6 + 4 > 8)
  {
    tick: 5,
    command: {
      command_id: "op-0003",
      type: "inventory.move",
      payload: {
        from_location_id: "loc-00-001",
        to_location_id: "loc-01-012",
        sku: "sku-std-pallet",
        quantity: 2,
      },
    },
  },
  {
    tick: 5,
    command: {
      command_id: "op-0004",
      type: "inventory.move",
      payload: {
        from_location_id: "loc-00-001",
        to_location_id: "loc-01-011",
        sku: "sku-std-pallet",
        quantity: 5,
      },
    },
  }, // INSUFFICIENT_STOCK (4 left)
  {
    tick: 9,
    command: {
      command_id: "op-0005",
      type: "inventory.adjust",
      payload: { location_id: "loc-00-001", sku: "sku-std-pallet", delta: -1, reason: "damage" },
    },
  },
  {
    tick: 12,
    command: {
      command_id: "op-0006",
      type: "inventory.receive",
      payload: { location_id: "loc-99-999", sku: "sku-std-pallet", quantity: 1 },
    },
  }, // UNKNOWN_LOCATION
];

export const FOUNDATION_DEMO_TICKS = 600;
