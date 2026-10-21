/**
 * Pure mapping from authoritative simulation data to renderable instances.
 *
 * Nothing here creates operational data. With operational state (Phase 2, every facility
 * scenario) pallets, vehicles and trucks are drawn from `state.ops` via `ops-view.ts`. Configs
 * without facility data (the Phase 0 golden scenario) only have per-bay quantities in
 * `state.inventory`; `derivePallets` draws those with a deterministic bottom-up slot convention.
 */
import type {
  EquipmentConfig,
  FacilityConfig,
  InventoryTable,
  LocationConfig,
  Point2,
  RackSpec,
  SimulationConfig,
} from "@warehouse-one/simulation";
import { STANDARD_RACK } from "@warehouse-one/simulation";

export type Vec3 = readonly [number, number, number];

/** The yard is 1.2 m below the warehouse floor: standard dock height, so trailer beds meet the floor. */
export const YARD_LEVEL = -1.2;

export interface Bounds {
  readonly min: Point2;
  readonly max: Point2;
}

/** Cargo visual archetypes; SKUs map onto them by position in the SKU list. */
export const CARGO_ARCHETYPES = ["cartons", "cold-chain", "bulk-bag", "electronics"] as const;
export type CargoArchetype = (typeof CARGO_ARCHETYPES)[number];

export function archetypeForSku(config: SimulationConfig, sku: string): CargoArchetype {
  const index = Math.max(
    0,
    config.skus.findIndex((s) => s.id === sku),
  );
  return CARGO_ARCHETYPES[index % CARGO_ARCHETYPES.length] as CargoArchetype;
}

/**
 * The facility to draw. Configs without facility data (e.g. the Phase 0 golden scenario) get a
 * plain building fitted around their locations and no docks or vehicles: nothing is invented.
 */
export function resolveFacility(config: SimulationConfig): FacilityConfig {
  if (config.facility) return config.facility;
  const xs = config.locations.map((l) => l.position.x);
  const zs = config.locations.map((l) => l.position.z);
  const min = { x: Math.min(0, ...xs) - 6, z: Math.min(0, ...zs) - 6 };
  const max = { x: Math.max(0, ...xs) + 6, z: Math.max(0, ...zs) + 6 };
  return {
    name: "Unnamed facility",
    building: { min, max, height: 10 },
    site: { min: { x: min.x - 6, z: min.z - 6 }, max: { x: max.x + 6, z: max.z + 6 } },
    rack: STANDARD_RACK,
    docks: [],
    equipment: [],
  };
}

export function levelsFor(capacity: number, rack: RackSpec): number {
  return Math.ceil(capacity / rack.positions_per_level);
}

/** Rotate a local (x, z) offset by yaw and translate to the location's floor position. */
export function toWorld(origin: Point2, yaw: number, local: Point2): Point2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: origin.x + local.x * c + local.z * s, z: origin.z - local.x * s + local.z * c };
}

/** Local slot centre within a bay: x along the beam, y = top of the supporting beam (or floor). */
export function slotLocal(slot: number, rack: RackSpec): { x: number; y: number; level: number } {
  const level = Math.floor(slot / rack.positions_per_level);
  const column = slot % rack.positions_per_level;
  const pitch = rack.bay_width / rack.positions_per_level;
  return { x: -rack.bay_width / 2 + pitch * (column + 0.5), y: level * rack.level_height, level };
}

export interface PalletInstance {
  readonly locationId: string;
  readonly sku: string;
  readonly slot: number;
  readonly archetype: CargoArchetype;
  readonly position: Vec3;
  readonly yaw: number;
  /** Stable per-unit variation seed (0..1) for subtle colour jitter. */
  readonly variation: number;
}

/** One instance per stored unit, in deterministic order. */
export function derivePallets(
  config: SimulationConfig,
  inventory: InventoryTable,
  rack: RackSpec,
): PalletInstance[] {
  const skuOrder = new Map(config.skus.map((s, i) => [s.id, i]));
  const out: PalletInstance[] = [];
  for (const loc of config.locations) {
    const row = inventory[loc.id];
    if (!row) continue;
    const skus = Object.keys(row).sort((a, b) => (skuOrder.get(a) ?? 0) - (skuOrder.get(b) ?? 0));
    let slot = 0;
    for (const sku of skus) {
      const qty = row[sku] ?? 0;
      for (let u = 0; u < qty; u++, slot++) {
        const local = slotLocal(slot, rack);
        const p = toWorld(loc.position, loc.yaw ?? 0, { x: local.x, z: 0 });
        out.push({
          locationId: loc.id,
          sku,
          slot,
          archetype: archetypeForSku(config, sku),
          position: [p.x, local.y, p.z],
          yaw: loc.yaw ?? 0,
          variation: hash01(`${loc.id}:${slot}`),
        });
      }
    }
  }
  return out;
}

export interface RackRow {
  readonly id: string;
  readonly yaw: number;
  readonly locations: readonly LocationConfig[];
}

/** Group locations that share a rack line (same yaw and the same perpendicular offset). */
export function rackRows(config: SimulationConfig): RackRow[] {
  const rows = new Map<string, LocationConfig[]>();
  for (const loc of config.locations) {
    const yaw = loc.yaw ?? 0;
    const offset = -loc.position.x * Math.sin(yaw) + loc.position.z * Math.cos(yaw);
    const key = `${yaw.toFixed(3)}|${offset.toFixed(2)}`;
    rows.set(key, [...(rows.get(key) ?? []), loc]);
  }
  return [...rows.entries()].map(([key, locations]) => ({
    id: key,
    yaw: locations[0]?.yaw ?? 0,
    locations: [...locations].sort((a, b) => along(a, a.yaw ?? 0) - along(b, b.yaw ?? 0)),
  }));
}

const along = (l: LocationConfig, yaw: number) =>
  l.position.x * Math.cos(yaw) - l.position.z * Math.sin(yaw);

export interface RackParts {
  /** Upright posts: centre position and height. */
  readonly posts: { position: Vec3; height: number; yaw: number }[];
  /** Diagonal/horizontal frame bracing between the front and back post of a frame. */
  readonly braces: { position: Vec3; yaw: number; tilt: number; length: number }[];
  /** Load beams: centre position (top of beam at `level * level_height`). */
  readonly beams: { position: Vec3; yaw: number; length: number }[];
  /** Post protectors at the aisle ends of each row. */
  readonly guards: { position: Vec3; yaw: number }[];
}

/** Static racking structure for the configured locations (independent of inventory). */
export function deriveRackParts(config: SimulationConfig, rack: RackSpec): RackParts {
  const parts: RackParts = { posts: [], braces: [], beams: [], guards: [] };
  const maxLevels = Math.max(1, ...config.locations.map((l) => levelsFor(l.capacity, rack)));
  const height = (maxLevels - 1) * rack.level_height + 1.4;

  for (const row of rackRows(config)) {
    const frames = new Map<string, { origin: Point2; yaw: number }>();
    for (const loc of row.locations) {
      const yaw = loc.yaw ?? 0;
      for (const side of [-1, 1]) {
        const p = toWorld(loc.position, yaw, { x: (side * rack.bay_width) / 2, z: 0 });
        frames.set(`${p.x.toFixed(2)},${p.z.toFixed(2)}`, { origin: p, yaw });
      }
      const levels = levelsFor(loc.capacity, rack);
      for (let level = 1; level < levels; level++) {
        for (const face of [-1, 1]) {
          const p = toWorld(loc.position, yaw, { x: 0, z: (face * (rack.depth - 0.08)) / 2 });
          parts.beams.push({
            position: [p.x, level * rack.level_height - 0.06, p.z],
            yaw,
            length: rack.bay_width - 0.09,
          });
        }
      }
    }
    const frameList = [...frames.values()];
    frameList.forEach((f, i) => {
      for (const face of [-1, 1]) {
        const p = toWorld(f.origin, f.yaw, { x: 0, z: (face * (rack.depth - 0.08)) / 2 });
        parts.posts.push({ position: [p.x, height / 2, p.z], height, yaw: f.yaw });
      }
      // Zig-zag bracing in the frame plane.
      const span = rack.depth - 0.08;
      const step = 1.2;
      for (let y = 0.25, k = 0; y + step <= height - 0.1; y += step, k++) {
        const tilt = Math.atan2(step, span) * (k % 2 === 0 ? 1 : -1);
        parts.braces.push({
          position: [f.origin.x, y + step / 2, f.origin.z],
          yaw: f.yaw,
          tilt,
          length: Math.hypot(step, span),
        });
      }
      if (i === 0 || i === frameList.length - 1) {
        for (const face of [-1, 1]) {
          const p = toWorld(f.origin, f.yaw, { x: 0, z: (face * (rack.depth + 0.12)) / 2 });
          parts.guards.push({ position: [p.x, 0.2, p.z], yaw: f.yaw });
        }
      }
    });
  }
  return parts;
}

/** Axis-aligned footprint of a location's bay (world space, XZ). */
export function bayBounds(loc: LocationConfig, rack: RackSpec): Bounds {
  const yaw = loc.yaw ?? 0;
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sz]) =>
    toWorld(loc.position, yaw, {
      x: ((sx ?? 0) * rack.bay_width) / 2,
      z: ((sz ?? 0) * rack.depth) / 2,
    }),
  );
  return {
    min: { x: Math.min(...corners.map((c) => c.x)), z: Math.min(...corners.map((c) => c.z)) },
    max: { x: Math.max(...corners.map((c) => c.x)), z: Math.max(...corners.map((c) => c.z)) },
  };
}

/** Approximate vehicle footprint (length along heading, width) in metres. */
export const VEHICLE_SIZE: Record<
  EquipmentConfig["kind"],
  { length: number; width: number; height: number }
> = {
  counterbalance_forklift: { length: 3.3, width: 1.2, height: 2.2 },
  reach_truck: { length: 2.6, width: 1.3, height: 2.4 },
  truck: { length: 16.5, width: 2.55, height: 4.0 },
};

export interface SceneCounts {
  /** Pallets drawn: in racks, in staging lanes and on forks (pallets inside trailers are hidden). */
  pallets: number;
  palletsByArchetype: Record<CargoArchetype, number>;
  /** Drawn pallets by where they are (operational scenarios only). */
  palletsByPlace?: { slot: number; staging: number; equipment: number };
  bays: number;
  vehicles: number;
  trucks: number;
  docks: number;
}

export function sceneCounts(
  config: SimulationConfig,
  pallets: readonly PalletInstance[],
): SceneCounts {
  const byArchetype = Object.fromEntries(CARGO_ARCHETYPES.map((a) => [a, 0])) as Record<
    CargoArchetype,
    number
  >;
  for (const p of pallets) byArchetype[p.archetype] += 1;
  const f = resolveFacility(config);
  return {
    pallets: pallets.length,
    palletsByArchetype: byArchetype,
    bays: config.locations.length,
    vehicles: f.equipment.length,
    trucks: 0,
    docks: f.docks.length,
  };
}

/** Deterministic 0..1 hash (FNV-1a) for visual variation. */
export function hash01(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}
