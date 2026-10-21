/**
 * Pure mapping from authoritative operational state (`state.ops`, Phase 2) to what the renderer
 * draws and the panels show. Poses come from the simulation's own pose functions
 * (`equipmentPose`, `truckPose`, `palletWorld`); the only thing added here is interpolation
 * between the last two published ticks, which is visual and never feeds back into the simulation.
 */
import type { PalletPosition } from "@warehouse-one/contracts";
import {
  equipmentPose,
  navGraph,
  palletWorld,
  STAGING_LANE_CAPACITY,
  truckPose,
  type EquipmentPose,
  type EquipmentState,
  type MheKind,
  type OperationsState,
  type Pose,
  type SimulationConfig,
  type SimulationState,
  type TaskStatus,
  type TruckState,
} from "@warehouse-one/simulation";
import {
  archetypeForSku,
  CARGO_ARCHETYPES,
  hash01,
  type CargoArchetype,
  type SceneCounts,
  type Vec3,
} from "./derive";

const TAU = Math.PI * 2;

/** Interpolate an angle along the shorter arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return a + d * t;
}

/** Interpolate between two poses (t = 0 → a, t = 1 → b). Extra numeric fields are lerped too. */
export function lerpPose<P extends Pose>(a: P, b: P, t: number): P {
  if (t >= 1) return b;
  const out = { ...b } as unknown as Record<string, number>;
  for (const k of Object.keys(b) as (keyof P & string)[]) {
    const va = a[k];
    const vb = b[k];
    if (typeof va === "number" && typeof vb === "number")
      out[k] = k === "yaw" ? lerpAngle(va, vb, t) : va + (vb - va) * t;
  }
  return out as unknown as P;
}

// Vehicles -------------------------------------------------------------------------------------

export interface VehicleView {
  readonly id: string;
  readonly kind: MheKind;
  readonly status: EquipmentState["status"];
  readonly carrying: string | null;
  readonly pose: EquipmentPose;
}

/**
 * Material-handling vehicles at render time `alpha` between the previous tick (0) and the latest
 * tick (1). A vehicle without a previous state is drawn at its latest pose.
 */
export function vehicleViews(
  config: SimulationConfig,
  prev: OperationsState | undefined,
  curr: OperationsState,
  alpha: number,
): VehicleView[] {
  const g = navGraph(config);
  return Object.keys(curr.equipment)
    .sort()
    .map((id) => {
      const e = curr.equipment[id] as EquipmentState;
      const before = prev?.equipment[id];
      const pose = before
        ? lerpPose(equipmentPose(g, before), equipmentPose(g, e), alpha)
        : equipmentPose(g, e);
      return { id, kind: e.kind, status: e.status, carrying: e.carrying, pose };
    });
}

// Trucks ---------------------------------------------------------------------------------------

export interface TruckView {
  readonly id: string;
  readonly direction: TruckState["direction"];
  readonly status: TruckState["status"];
  readonly pose: Pose;
}

/** Trucks on site (departed trucks have left state and are not drawn). */
export function truckViews(
  config: SimulationConfig,
  prev: OperationsState | undefined,
  curr: OperationsState,
  alpha: number,
): TruckView[] {
  const out: TruckView[] = [];
  for (const id of Object.keys(curr.trucks).sort()) {
    const t = curr.trucks[id] as TruckState;
    const now = truckPose(config, t);
    if (!now) continue;
    const beforeState = prev?.trucks[id];
    const before = beforeState ? truckPose(config, beforeState) : null;
    out.push({
      id,
      direction: t.direction,
      status: t.status,
      pose: before ? lerpPose(before, now, alpha) : now,
    });
  }
  return out;
}

// Pallets --------------------------------------------------------------------------------------

export type PalletPlace = "slot" | "staging" | "equipment";

export interface PalletView {
  readonly id: string;
  readonly sku: string;
  readonly archetype: CargoArchetype;
  readonly place: PalletPlace;
  readonly position: Vec3;
  readonly yaw: number;
  /** Stable per-pallet variation seed (0..1) for subtle colour jitter. */
  readonly variation: number;
}

function view(
  config: SimulationConfig,
  id: string,
  sku: string,
  place: PalletPlace,
  p: Pose & { y: number },
): PalletView {
  return {
    id,
    sku,
    archetype: archetypeForSku(config, sku),
    place,
    position: [p.x, p.y, p.z],
    yaw: p.yaw,
    variation: hash01(id),
  };
}

/**
 * Pallets that stay put between pallet moves: in rack slots and in staging lanes, in pallet-id
 * order. Pallets inside trailers are out of sight and not drawn; pallets on forks move every frame
 * and come from `carriedPallets`.
 */
export function staticPallets(config: SimulationConfig, state: SimulationState): PalletView[] {
  const ops = state.ops;
  if (!ops) return [];
  const out: PalletView[] = [];
  for (const id of Object.keys(ops.pallets).sort()) {
    const p = ops.pallets[id];
    if (!p || (p.at.kind !== "slot" && p.at.kind !== "staging")) continue;
    const w = palletWorld(config, state, p.at);
    if (w) out.push(view(config, id, p.sku, p.at.kind, w));
  }
  return out;
}

/** Pallets on forks, placed on the interpolated vehicle poses. */
export function carriedPallets(
  config: SimulationConfig,
  state: SimulationState,
  vehicles: readonly VehicleView[],
): PalletView[] {
  const ops = state.ops;
  if (!ops) return [];
  const poses = new Map(vehicles.map((v) => [v.id, v.pose]));
  const out: PalletView[] = [];
  for (const v of vehicles) {
    if (!v.carrying) continue;
    const p = ops.pallets[v.carrying];
    if (!p || p.at.kind !== "equipment") continue;
    const w = palletWorld(config, state, p.at, (id) => poses.get(id));
    if (w) out.push(view(config, p.id, p.sku, "equipment", w));
  }
  return out;
}

/** Instance buffer size for static pallets: every rack slot plus every staging position. */
export function staticPalletCapacity(config: SimulationConfig): number {
  const slots = config.locations.reduce((n, l) => n + l.capacity, 0);
  return slots + (config.facility?.docks.length ?? 0) * STAGING_LANE_CAPACITY;
}

// Summaries ------------------------------------------------------------------------------------

export type PositionKind = PalletPosition["kind"];

export interface OpsSummary {
  readonly palletsByPlace: Record<PositionKind, number>;
  readonly tasks: number;
  readonly tasksByStatus: Record<TaskStatus, number>;
  readonly vehicles: number;
  /** Vehicles working on a task. */
  readonly vehiclesBusy: number;
  readonly trucks: number;
  readonly trucksDocked: number;
  readonly docks: number;
  readonly docksOccupied: number;
  readonly orders: number;
}

export function opsSummary(ops: OperationsState): OpsSummary {
  const palletsByPlace: Record<PositionKind, number> = {
    slot: 0,
    staging: 0,
    equipment: 0,
    truck: 0,
  };
  for (const p of Object.values(ops.pallets)) palletsByPlace[p.at.kind] += 1;
  const tasksByStatus: Record<TaskStatus, number> = {
    pending: 0,
    assigned: 0,
    picking: 0,
    carrying: 0,
    dropping: 0,
  };
  for (const t of Object.values(ops.tasks)) tasksByStatus[t.status] += 1;
  const equipment = Object.values(ops.equipment);
  const trucks = Object.values(ops.trucks);
  const docks = Object.values(ops.docks);
  return {
    palletsByPlace,
    tasks: Object.keys(ops.tasks).length,
    tasksByStatus,
    vehicles: equipment.length,
    vehiclesBusy: equipment.filter((e) => e.task_id !== null).length,
    trucks: trucks.length,
    trucksDocked: trucks.filter((t) => t.status === "docked").length,
    docks: docks.length,
    docksOccupied: docks.filter((d) => d.truck_id !== null).length,
    orders: Object.keys(ops.orders).length,
  };
}

/** Free stock per SKU: stored in a rack slot, not allocated to an order, not being moved. */
export function freeStock(ops: OperationsState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of Object.values(ops.pallets))
    if (p.at.kind === "slot" && !p.order_id && !p.task_id) out[p.sku] = (out[p.sku] ?? 0) + 1;
  return out;
}

/** Where a pallet position is, in operator language. */
export function describePosition(p: PalletPosition): string {
  switch (p.kind) {
    case "slot":
      return `${p.location_id} · slot ${p.slot}`;
    case "staging":
      return `${p.dock_id} · lane ${p.position}`;
    case "equipment":
      return `on ${p.equipment_id}`;
    case "truck":
      return `in ${p.truck_id}`;
  }
}

/**
 * What the scene draws for an operational state: pallets in racks and staging lanes (`statics`)
 * plus one pallet per vehicle carrying one, every vehicle, and every truck on site.
 */
export function opsSceneCounts(
  config: SimulationConfig,
  ops: OperationsState,
  statics: readonly PalletView[],
): SceneCounts {
  const byArchetype = Object.fromEntries(CARGO_ARCHETYPES.map((a) => [a, 0])) as Record<
    CargoArchetype,
    number
  >;
  const byPlace = { slot: 0, staging: 0, equipment: 0 };
  for (const p of statics) {
    byArchetype[p.archetype] += 1;
    byPlace[p.place] += 1;
  }
  for (const e of Object.values(ops.equipment)) {
    const p = e.carrying ? ops.pallets[e.carrying] : undefined;
    if (!p || p.at.kind !== "equipment") continue;
    byArchetype[archetypeForSku(config, p.sku)] += 1;
    byPlace.equipment += 1;
  }
  return {
    pallets: byPlace.slot + byPlace.staging + byPlace.equipment,
    palletsByArchetype: byArchetype,
    palletsByPlace: byPlace,
    bays: config.locations.length,
    vehicles: Object.keys(ops.equipment).length,
    trucks: Object.keys(ops.trucks).length,
    docks: config.facility?.docks.length ?? 0,
  };
}
