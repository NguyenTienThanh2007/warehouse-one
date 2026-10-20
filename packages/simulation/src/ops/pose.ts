import type { PalletPosition } from "@warehouse-one/contracts";
import type { LocationConfig, SimulationConfig, SimulationState } from "../types";
import { TRUCK_DEPARTING_TICKS, TRUCK_DOCKING_TICKS, type EquipmentState, type Heading, type TruckState } from "./model";
import { navGraph, type NavGraph } from "./nav";

/**
 * World poses derived from authoritative state (metres, radians). Pure functions shared by tests
 * and the renderer, so what is drawn is exactly what the simulation says. Rendering may
 * interpolate between two ticks' poses, but never feeds anything back.
 */

export interface Pose {
  readonly x: number;
  readonly z: number;
  /** Rotation about +y; forward is (sin yaw, cos yaw). */
  readonly yaw: number;
}

export interface EquipmentPose extends Pose {
  /** Fork height above the floor (m). */
  readonly fork: number;
}

const HEADING_YAW: Record<Heading, number> = { pz: 0, px: Math.PI / 2, nz: Math.PI, nx: -Math.PI / 2 };
export const headingYaw = (h: Heading) => HEADING_YAW[h];

/** Travel height of empty forks and of a carried pallet's underside (m). */
const FORK_TRAVEL_EMPTY = 0.08;
const FORK_TRAVEL_LOADED = 0.18;

export function equipmentPose(g: NavGraph, e: EquipmentState): EquipmentPose {
  const a = g.nodes.get(e.node);
  if (!a) return { x: 0, z: 0, yaw: 0, fork: 0 };
  let x = a.x;
  let z = a.z;
  const next = e.route[0] ? g.nodes.get(e.route[0]) : undefined;
  if (next && e.progress_mm > 0) {
    const len = Math.abs(next.x - a.x) + Math.abs(next.z - a.z);
    const t = len > 0 ? e.progress_mm / len : 0;
    x = a.x + (next.x - a.x) * t;
    z = a.z + (next.z - a.z) * t;
  }
  let fork = e.carrying ? FORK_TRAVEL_LOADED : FORK_TRAVEL_EMPTY;
  if (e.handling) {
    // Raise to the lift height at the midpoint (pallet changes hands there), then lower.
    const p = 1 - e.handling.ticks_left / e.handling.ticks_total;
    fork = Math.max(fork, (e.handling.lift_mm / 1000) * (1 - Math.abs(2 * p - 1)) + FORK_TRAVEL_EMPTY);
  }
  return { x: x / 1000, z: z / 1000, yaw: headingYaw(e.handling?.facing ?? e.heading), fork };
}

/** Local slot centre in a bay: x along the beam, y = beam top (level 0 is the floor). */
export function slotLocal(config: SimulationConfig, slot: number): { x: number; y: number; level: number } {
  const rack = config.facility!.rack;
  const level = Math.floor(slot / rack.positions_per_level);
  const column = slot % rack.positions_per_level;
  const pitch = rack.bay_width / rack.positions_per_level;
  return { x: -rack.bay_width / 2 + pitch * (column + 0.5), y: level * rack.level_height, level };
}

export function slotWorld(config: SimulationConfig, loc: LocationConfig, slot: number): Pose & { y: number } {
  const local = slotLocal(config, slot);
  const yaw = loc.yaw ?? 0;
  return {
    x: loc.position.x + local.x * Math.cos(yaw),
    z: loc.position.z - local.x * Math.sin(yaw),
    y: local.y,
    yaw,
  };
}

// Trucks ---------------------------------------------------------------------------------------

export const TRUCK_LENGTH = 16.5;
const DOCK_GAP = 0.6;
const YARD_ROW_OFFSET = TRUCK_LENGTH + DOCK_GAP + 2;

const ease = (t: number) => t * t * (3 - 2 * t);

/** Pose of a truck with its rear at a dock door (front pointing away from the building). */
export function dockedTruckPose(config: SimulationConfig, dockId: string): Pose {
  const d = config.facility!.docks.find((x) => x.id === dockId)!;
  return { x: d.position.x, z: d.position.z + DOCK_GAP + TRUCK_LENGTH / 2, yaw: 0 };
}

/** Waiting position in the yard row behind the docks. */
export function yardPose(config: SimulationConfig, slot: number): Pose {
  const docks = [...config.facility!.docks].sort((a, b) => a.id.localeCompare(b.id));
  const d = docks[slot % docks.length]!;
  return { x: d.position.x, z: d.position.z + YARD_ROW_OFFSET + DOCK_GAP + TRUCK_LENGTH / 2, yaw: 0 };
}

/**
 * Truck pose from its lifecycle state. Docking: shift sideways in the yard row, then reverse onto the
 * dock. Departing: drive out of the site. Returns null when the truck has left the site.
 */
export function truckPose(config: SimulationConfig, t: TruckState): Pose | null {
  const yard = yardPose(config, t.yard_slot);
  switch (t.status) {
    case "yard":
      return yard;
    case "docked":
      return dockedTruckPose(config, t.dock_id!);
    case "docking": {
      const dock = dockedTruckPose(config, t.dock_id!);
      const p = 1 - t.motion_ticks_left / TRUCK_DOCKING_TICKS;
      if (p < 0.4) return { x: yard.x + (dock.x - yard.x) * ease(p / 0.4), z: yard.z, yaw: 0 };
      return { x: dock.x, z: yard.z + (dock.z - yard.z) * ease((p - 0.4) / 0.6), yaw: 0 };
    }
    case "departing": {
      const from = t.dock_id ? dockedTruckPose(config, t.dock_id) : yard;
      const p = 1 - t.motion_ticks_left / TRUCK_DEPARTING_TICKS;
      const exit = config.facility!.site.max.z + TRUCK_LENGTH;
      return { x: from.x, z: from.z + (exit - from.z) * ease(p), yaw: 0 };
    }
  }
}

// Pallets --------------------------------------------------------------------------------------

/** World centre of a staging position (m). */
export function stagingWorld(config: SimulationConfig, dockId: string, position: number): Pose {
  const spot = navGraph(config).stagingSpots.get(dockId)?.[position];
  return { x: (spot?.x ?? 0) / 1000, z: (spot?.z ?? 0) / 1000, yaw: Math.PI / 2 };
}

/**
 * Where a pallet is drawn, or null when it is out of sight (inside a trailer). Pallets on forks
 * follow the vehicle pose: centred on the forks, at fork height.
 */
export function palletWorld(
  config: SimulationConfig,
  state: SimulationState,
  at: PalletPosition,
  equipmentPoseOf: (id: string) => EquipmentPose | undefined = (id) => {
    const e = state.ops?.equipment[id];
    return e ? equipmentPose(navGraph(config), e) : undefined;
  },
): (Pose & { y: number }) | null {
  switch (at.kind) {
    case "slot": {
      const loc = config.locations.find((l) => l.id === at.location_id);
      return loc ? slotWorld(config, loc, at.slot) : null;
    }
    case "staging":
      return { ...stagingWorld(config, at.dock_id, at.position), y: 0 };
    case "equipment": {
      const e = state.ops?.equipment[at.equipment_id];
      const pose = equipmentPoseOf(at.equipment_id);
      if (!e || !pose) return null;
      const reach = e.kind === "reach_truck" ? 0.62 : 1.15;
      return { x: pose.x + Math.sin(pose.yaw) * reach, z: pose.z + Math.cos(pose.yaw) * reach, y: pose.fork - 0.04, yaw: pose.yaw };
    }
    case "truck":
      return null;
  }
}
