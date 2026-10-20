import type { SimulationConfig } from "../types";
import type { EquipmentState, Heading, MheKind, OperationsState } from "./model";
import { BATTERY_FULL } from "./model";
import { navGraph } from "./nav";

/** Heading closest to a configured yaw (pick face convention: direction (sin yaw, cos yaw)). */
function headingFromYaw(yaw: number): Heading {
  const s = Math.round(Math.sin(yaw));
  const c = Math.round(Math.cos(yaw));
  if (s > 0) return "px";
  if (s < 0) return "nx";
  return c >= 0 ? "pz" : "nz";
}

/** Initial operational state: every vehicle idle at its charger, every dock free, nothing else. */
export function initialOperations(config: SimulationConfig): OperationsState | undefined {
  const f = config.facility;
  if (!f) return undefined;
  const g = navGraph(config);
  const equipment: Record<string, EquipmentState> = {};
  for (const e of [...f.equipment].sort((a, b) => a.id.localeCompare(b.id))) {
    if (e.kind === "truck") continue;
    equipment[e.id] = {
      id: e.id,
      kind: e.kind as MheKind,
      status: "idle",
      node: g.chargerNode.get(e.id) as string,
      route: [],
      progress_mm: 0,
      heading: headingFromYaw(e.yaw),
      purpose: null,
      task_id: null,
      carrying: null,
      battery_permille: e.battery_permille ?? BATTERY_FULL,
      drain_mm: 0,
      handling: null,
      zone_claim: null,
      wait_ticks: 0,
      blocked_by: null,
      odometer_mm: 0,
      status_since_tick: 0,
    };
  }
  const docks = Object.fromEntries([...f.docks].sort((a, b) => a.id.localeCompare(b.id)).map((d) => [d.id, { truck_id: null }]));
  return {
    pallets: {},
    equipment,
    tasks: {},
    trucks: {},
    orders: {},
    docks,
    reservations: {},
    next_id: { pallet: 0, task: 0, truck: 0, order: 0 },
  };
}
