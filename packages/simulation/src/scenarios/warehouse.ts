import type { SimulationCommand } from "@warehouse-one/contracts";
import type { OperationsWorkloadConfig } from "../ops/model";
import { deterministicUuid } from "../hash";
import { nextFloat, nextInt, seedRng, type RngState } from "../rng";
import type {
  DockConfig,
  EquipmentConfig,
  FacilityConfig,
  LocationConfig,
  RackSpec,
  SimulationConfig,
  SkuConfig,
} from "../types";

/** Selective pallet racking: 2 pallets per beam level, 1.6 m level pitch, 2.4 m bays. */
export const STANDARD_RACK: RackSpec = {
  bay_width: 2.4,
  depth: 1.1,
  level_height: 1.6,
  positions_per_level: 2,
};

/** Physical layout constants (metres). */
export const LAYOUT = {
  /** Gap between back-to-back rows. */
  flue: 0.3,
  /** Forklift working aisle between pick faces. */
  aisle: 3.6,
  /** Cross aisle at the row ends; the -x end also holds the charging area. */
  crossAisle: 5,
  chargingAisle: 8,
  /** Open floor between the last rack row and the dock wall (staging lanes). */
  staging: 15,
  dockPitch: 4.6,
  /** Yard depth outside the dock wall: docked trucks plus a row of waiting trucks. */
  yard: 42,
  /** Overall truck length (tractor + 13.6 m trailer) used for parking positions. */
  truckLength: 16.5,
} as const;

export const SHOWCASE_SKUS: readonly SkuConfig[] = [
  { id: "sku-std-pallet", name: "Mixed cartons (ambient)" },
  { id: "sku-cold-chain", name: "Insulated cold-chain container" },
  { id: "sku-bulk-bags", name: "Bulk bags (FIBC)" },
  { id: "sku-electronics", name: "Boxed electronics" },
];

export interface WarehouseOptions {
  readonly name: string;
  readonly rows: number;
  readonly bays: number;
  readonly capacity?: number;
  readonly docks?: number;
  readonly forklifts?: number;
  readonly reachTrucks?: number;
  /** Trucks reversed onto docks (assigned to every other dock from the left). */
  /** Initial battery (permille) per vehicle, in id order; defaults to full. */
  readonly batteries?: readonly number[];
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/**
 * Generate a rack layout and the surrounding facility. Rows come in back-to-back pairs with a
 * working aisle in front of every pick face; docks sit on the +z wall, the charging area at the
 * -x cross aisle. The building is centred on the origin.
 */
export function buildWarehouse(o: WarehouseOptions): {
  locations: LocationConfig[];
  facility: FacilityConfig;
} {
  const rack = STANDARD_RACK;
  const capacity = o.capacity ?? 8;
  const rowLength = o.bays * rack.bay_width;

  // Row centre lines along z, starting after the back aisle.
  const rowZ: { z: number; yaw: number }[] = [];
  let cursor = LAYOUT.aisle;
  for (let r = 0; r < o.rows; r++) {
    const backToBack = r % 2 === 1;
    if (r > 0) cursor += backToBack ? LAYOUT.flue : LAYOUT.aisle;
    // Even rows face the aisle behind them (-z), odd rows face the aisle in front (+z).
    rowZ.push({ z: cursor + rack.depth / 2, yaw: r % 2 === 0 ? Math.PI : 0 });
    cursor += rack.depth;
  }
  const depth = cursor + LAYOUT.staging;
  const zShift = -depth / 2;

  const locations: LocationConfig[] = [];
  rowZ.forEach((row, r) => {
    for (let b = 0; b < o.bays; b++) {
      locations.push({
        id: `loc-${pad(r, 2)}-${pad(b + 1, 3)}`,
        zone: `row-${String.fromCharCode(97 + (r % 26))}`,
        capacity,
        position: {
          x: round(-rowLength / 2 + (b + 0.5) * rack.bay_width),
          z: round(row.z + zShift),
        },
        yaw: row.yaw,
      });
    }
  });

  const building = {
    min: { x: round(-rowLength / 2 - LAYOUT.chargingAisle), z: round(zShift) },
    max: { x: round(rowLength / 2 + LAYOUT.crossAisle), z: round(depth + zShift) },
    height: 10,
  };
  const site = {
    min: { x: building.min.x - 8, z: building.min.z - 6 },
    max: { x: building.max.x + 8, z: building.max.z + LAYOUT.yard },
  };

  const dockCount = o.docks ?? 4;
  const docksCentre = (building.min.x + building.max.x) / 2 + 2;
  const docks: DockConfig[] = [];
  for (let i = 0; i < dockCount; i++) {
    docks.push({
      id: `dock-${pad(i + 1, 2)}`,
      position: {
        x: round(docksCentre + (i - (dockCount - 1) / 2) * LAYOUT.dockPitch),
        z: building.max.z,
      },
      yaw: 0,
    });
  }

  const equipment: EquipmentConfig[] = [];
  const battery = (i: number) => o.batteries?.[i] ?? 1000;
  const chargeX = building.min.x + 2.4;
  const chargeZ0 = building.max.z - 3;
  for (let i = 0; i < (o.forklifts ?? 3); i++) {
    equipment.push({
      id: `fl-${pad(i + 1, 2)}`,
      kind: "counterbalance_forklift",
      label: `Counterbalance forklift FL-${pad(i + 1, 2)}`,
      position: { x: chargeX, z: round(chargeZ0 - i * 2.6) },
      yaw: Math.PI / 2,
      rated_capacity_kg: 2500,
      battery_permille: battery(i),
    });
  }
  const reachStart = o.forklifts ?? 3;
  for (let i = 0; i < (o.reachTrucks ?? 1); i++) {
    equipment.push({
      id: `rt-${pad(i + 1, 2)}`,
      kind: "reach_truck",
      label: `Reach truck RT-${pad(i + 1, 2)}`,
      position: { x: chargeX, z: round(chargeZ0 - (reachStart + i) * 2.6 - 0.4) },
      yaw: Math.PI / 2,
      rated_capacity_kg: 1600,
      battery_permille: battery(reachStart + i),
    });
  }
  return {
    locations,
    facility: { name: o.name, building, site, rack, aisle_width: LAYOUT.aisle, docks, equipment },
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly label: string;
  readonly description: string;
  readonly config: SimulationConfig;
  /** Applied at tick 1 through the normal command path (so they are logged and replayable). */
  readonly openingCommands: readonly SimulationCommand[];
}

export const SCENARIO_IDS = ["showcase", "empty", "bench-100", "bench-300", "bench-1000"] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

function baseConfig(
  id: ScenarioId,
  layout: ReturnType<typeof buildWarehouse>,
  workload: OperationsWorkloadConfig | undefined,
): SimulationConfig {
  return {
    simulation_id: deterministicUuid(`scenario:${id}`, 0),
    seed: `warehouse-one-${id}`,
    tick_ms: 100,
    epoch: "2026-01-05T06:00:00.000Z",
    locations: layout.locations,
    skus: SHOWCASE_SKUS,
    facility: layout.facility,
    ...(workload ? { operations_workload: workload } : {}),
  };
}

/** Each rack row has a dominant SKU (slotting by product family) with some mixing. */
function skuForRow(row: number, rng: RngState): [string, RngState] {
  const [mix, r1] = nextFloat(rng);
  const [alt, r2] = nextInt(r1, 0, SHOWCASE_SKUS.length - 1);
  const dominant = SHOWCASE_SKUS[row % SHOWCASE_SKUS.length] as SkuConfig;
  return [mix < 0.8 ? dominant.id : (SHOWCASE_SKUS[alt] as SkuConfig).id, r2];
}

const rowOf = (loc: LocationConfig) => Number(loc.id.slice(4, 6));

/** Opening stock at roughly `fill` of capacity, varied per bay, from a seeded RNG. */
function openingStock(config: SimulationConfig, fill: number): SimulationCommand[] {
  let rng = seedRng(`${config.seed}:opening-stock`);
  const commands: SimulationCommand[] = [];
  for (const loc of config.locations) {
    let f: number;
    [f, rng] = nextFloat(rng);
    let units = Math.round(loc.capacity * Math.min(1, Math.max(0, fill + (f - 0.5) * 1.3)));
    while (units > 0) {
      let sku: string, qty: number;
      [sku, rng] = skuForRow(rowOf(loc), rng);
      [qty, rng] = nextInt(rng, 1, units);
      const prev = commands.at(-1);
      if (
        prev?.type === "inventory.receive" &&
        prev.payload.location_id === loc.id &&
        prev.payload.sku === sku
      ) {
        commands[commands.length - 1] = {
          ...prev,
          payload: { ...prev.payload, quantity: prev.payload.quantity + qty },
        };
      } else {
        commands.push({
          command_id: `open-${loc.id}-${commands.length}`,
          type: "inventory.receive",
          payload: { location_id: loc.id, sku, quantity: qty },
        });
      }
      units -= qty;
    }
  }
  return commands;
}

/** Fill bays in order until exactly `pallets` units are stored. */
function exactStock(config: SimulationConfig, pallets: number): SimulationCommand[] {
  let rng = seedRng(`${config.seed}:bench-stock`);
  const commands: SimulationCommand[] = [];
  let remaining = pallets;
  for (const loc of config.locations) {
    if (remaining === 0) break;
    const units = Math.min(loc.capacity, remaining);
    let sku: string;
    [sku, rng] = skuForRow(rowOf(loc), rng);
    commands.push({
      command_id: `bench-${loc.id}`,
      type: "inventory.receive",
      payload: { location_id: loc.id, sku, quantity: units },
    });
    remaining -= units;
  }
  if (remaining > 0) throw new Error(`layout too small for ${pallets} pallets`);
  return commands;
}

/** Fleet of the standard layouts: three counterbalance forklifts and one reach truck. */
const FLEET = { forklifts: 3, reachTrucks: 1, batteries: [1000, 860, 720, 940] } as const;

export function createShowcaseScenario(): Scenario {
  const layout = buildWarehouse({
    name: "WAREHOUSE ONE · Northgate DC",
    rows: 6,
    bays: 14,
    docks: 4,
    ...FLEET,
  });
  const config = baseConfig("showcase", layout, {
    // Measured at ~63–70% fleet utilisation with a bounded backlog (one-way aisles, ~1,000 ticks
    // per task); see docs/phases/PHASE_2.md.
    inbound_interval_ticks: 3600,
    outbound_interval_ticks: 3600,
    relocate_interval_ticks: 1800,
    min_pallets: 2,
    max_pallets: 4,
  });
  const stock = openingStock(config, 0.55);
  return {
    id: "showcase",
    label: "Showcase DC",
    description:
      "84 rack bays (672 positions), 4 docks, 4 vehicles; ~55% opening stock, one inbound truck and one order at start, then seeded trucks, orders and relocations.",
    config,
    openingCommands: [
      ...stock,
      {
        command_id: "open-inbound-1",
        type: "truck.schedule_inbound",
        payload: {
          cargo: [
            { sku: "sku-electronics", quantity: 3 },
            { sku: "sku-bulk-bags", quantity: 2 },
          ],
        },
      },
      {
        command_id: "open-order-1",
        type: "order.create",
        payload: {
          lines: [
            { sku: "sku-std-pallet", quantity: 2 },
            { sku: "sku-cold-chain", quantity: 2 },
          ],
        },
      },
    ],
  };
}

export function createEmptyScenario(): Scenario {
  const layout = buildWarehouse({
    name: "WAREHOUSE ONE · Northgate DC",
    rows: 6,
    bays: 14,
    docks: 4,
    ...FLEET,
  });
  return {
    id: "empty",
    label: "Empty facility",
    description: "Same building and fleet with no stock and no workload.",
    config: baseConfig("empty", layout, undefined),
    openingCommands: [],
  };
}

/** Benchmark scene with exactly `pallets` stored; relocations keep vehicles busy and the count constant. */
export function createBenchmarkScenario(pallets: 100 | 300 | 1000): Scenario {
  const rows = Math.max(2, 2 * Math.round(Math.sqrt(pallets / 64)));
  const bays = Math.ceil(pallets / (rows * 8));
  const id = `bench-${pallets}` as const;
  const layout = buildWarehouse({
    name: `Benchmark ${pallets}`,
    rows,
    bays,
    docks: 4,
    ...FLEET,
    batteries: [1000, 1000, 1000, 1000],
  });
  const config = baseConfig(id, layout, {
    inbound_interval_ticks: 0,
    outbound_interval_ticks: 0,
    // Measured at ~83–85% fleet utilisation with a backlog of at most five tasks.
    relocate_interval_ticks: 360,
    min_pallets: 1,
    max_pallets: 1,
  });
  return {
    id,
    label: `Benchmark · ${pallets} pallets`,
    description: `${rows} rows × ${bays} bays, exactly ${pallets} pallets, 4 vehicles relocating stock.`,
    config,
    openingCommands: exactStock(config, pallets),
  };
}

export function createScenario(id: ScenarioId): Scenario {
  switch (id) {
    case "showcase":
      return createShowcaseScenario();
    case "empty":
      return createEmptyScenario();
    case "bench-100":
      return createBenchmarkScenario(100);
    case "bench-300":
      return createBenchmarkScenario(300);
    case "bench-1000":
      return createBenchmarkScenario(1000);
  }
}

export function isScenarioId(value: string): value is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(value);
}
