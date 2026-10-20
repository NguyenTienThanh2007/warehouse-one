import type {
  CargoLine,
  EquipmentStatus,
  OrderStatus,
  PalletPosition,
  TaskType,
  TruckDirection,
  TruckStatus,
} from "@warehouse-one/contracts";

/**
 * Phase 2 operational state. It exists only for configs with facility data; configs without it
 * (the Phase 0 golden scenario) keep the Phase 0 state shape exactly.
 *
 * Units: positions and distances are integer millimetres; time is ticks. No floating-point or
 * trigonometric values are stored, so replays are bit-identical.
 */

export type Heading = "px" | "nx" | "pz" | "nz";

export interface PalletState {
  readonly id: string;
  readonly sku: string;
  readonly at: PalletPosition;
  /** Allocated to an outbound order (stays set until the pallet ships). */
  readonly order_id: string | null;
  /** The active task moving this pallet. */
  readonly task_id: string | null;
}

/** Non-terminal task states; completed and cancelled tasks leave state (their history is events). */
export type TaskStatus = "pending" | "assigned" | "picking" | "carrying" | "dropping";

export interface TaskState {
  readonly id: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  readonly pallet_id: string;
  readonly sku: string;
  readonly from: PalletPosition;
  readonly to: PalletPosition;
  readonly equipment_id: string | null;
  readonly order_id: string | null;
  readonly truck_id: string | null;
  readonly created_tick: number;
  /** The command that started this workflow (propagated to every event it causes). */
  readonly correlation_id: string;
}

export type MheKind = "counterbalance_forklift" | "reach_truck";
export type Purpose = "task" | "park" | "charge";

export interface HandlingState {
  readonly ticks_total: number;
  readonly ticks_left: number;
  /** Whether the pallet has changed hands (happens at the midpoint, at full lift). */
  readonly transferred: boolean;
  /** Fork lift height at the midpoint (mm). */
  readonly lift_mm: number;
  /** Direction the vehicle faces while handling. */
  readonly facing: Heading;
}

export interface EquipmentState {
  readonly id: string;
  readonly kind: MheKind;
  readonly status: EquipmentStatus;
  /** The node the vehicle is at, or has just left when `progress_mm > 0`. */
  readonly node: string;
  /** Remaining nodes to visit; `route[0]` is the next node. */
  readonly route: readonly string[];
  /** Distance travelled from `node` towards `route[0]`. */
  readonly progress_mm: number;
  readonly heading: Heading;
  readonly purpose: Purpose | null;
  readonly task_id: string | null;
  readonly carrying: string | null;
  readonly battery_permille: number;
  /** Distance travelled since the last battery decrement. */
  readonly drain_mm: number;
  readonly handling: HandlingState | null;
  /**
   * Exclusive zone (dock path or charging road) this vehicle has claimed. Claimed before stepping
   * onto the node in front of the zone, so a waiting vehicle never blocks the zone's exit.
   */
  readonly zone_claim: string | null;
  /** Ticks spent waiting for the next node; triggers replanning. */
  readonly wait_ticks: number;
  readonly blocked_by: string | null;
  readonly odometer_mm: number;
  readonly status_since_tick: number;
}

export interface TruckState {
  readonly id: string;
  readonly direction: TruckDirection;
  /** "departed" trucks are removed from state; the status history is in events. */
  readonly status: Exclude<TruckStatus, "departed">;
  readonly dock_id: string | null;
  readonly yard_slot: number;
  readonly order_id: string | null;
  /** Remaining manoeuvre time while docking or departing. */
  readonly motion_ticks_left: number;
  readonly status_since_tick: number;
  readonly correlation_id: string;
}

export interface OrderState {
  readonly id: string;
  /** Terminal orders (shipped, cancelled) leave state. */
  readonly status: Extract<OrderStatus, "open" | "in_progress">;
  readonly truck_id: string;
  readonly lines: readonly CargoLine[];
  readonly pallet_ids: readonly string[];
  readonly created_tick: number;
  readonly correlation_id: string;
}

export interface DockState {
  readonly truck_id: string | null;
}

export interface OperationsState {
  readonly pallets: Readonly<Record<string, PalletState>>;
  readonly equipment: Readonly<Record<string, EquipmentState>>;
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly trucks: Readonly<Record<string, TruckState>>;
  readonly orders: Readonly<Record<string, OrderState>>;
  readonly docks: Readonly<Record<string, DockState>>;
  /** Destination positions claimed by tasks: positionKey -> task id. */
  readonly reservations: Readonly<Record<string, string>>;
  readonly next_id: { readonly pallet: number; readonly task: number; readonly truck: number; readonly order: number };
}

/** Seeded generator of operational work for demos and benchmarks; disabled when absent. */
export interface OperationsWorkloadConfig {
  /** Schedule an inbound truck every N ticks (0 = never). */
  readonly inbound_interval_ticks: number;
  /** Create an outbound order every N ticks (0 = never). */
  readonly outbound_interval_ticks: number;
  /** Relocate a random stored pallet every N ticks (0 = never). */
  readonly relocate_interval_ticks: number;
  readonly min_pallets: number;
  readonly max_pallets: number;
}

// ---------------------------------------------------------------------------------------------
// Rules and timings (documented in docs/phases/PHASE_2.md §4).

export const STAGING_LANE_CAPACITY = 6;
/** Speeds in mm per 100 ms tick. */
export const SPEED_MM_PER_TICK: Record<MheKind, { empty: number; loaded: number }> = {
  counterbalance_forklift: { empty: 200, loaded: 160 },
  reach_truck: { empty: 180, loaded: 150 },
};
export const HANDLING_BASE_TICKS = 16;
export const HANDLING_TICKS_PER_LEVEL = 6;
export const BATTERY_FULL = 1000;
export const BATTERY_NEEDS_CHARGE = 300;
export const BATTERY_CHARGED = 950;
/** One permille of battery per this many millimetres travelled. */
export const BATTERY_DRAIN_MM = 2000;
export const BATTERY_DRAIN_PER_HANDLING = 2;
/** Charging adds one permille every N ticks. */
export const CHARGE_TICKS_PER_PERMILLE = 2;
export const WAIT_REPLAN_TICKS = 25;
export const TRUCK_DOCKING_TICKS = 80;
export const TRUCK_DEPARTING_TICKS = 60;

/** Only counterbalance trucks drive onto trailer beds; reach trucks are indoor-only. */
export function canPerform(kind: MheKind, type: TaskType): boolean {
  return kind === "counterbalance_forklift" || (type !== "load" && type !== "unload");
}

export function positionKey(p: PalletPosition): string {
  switch (p.kind) {
    case "slot":
      return `slot:${p.location_id}:${p.slot}`;
    case "staging":
      return `staging:${p.dock_id}:${p.position}`;
    case "equipment":
      return `equipment:${p.equipment_id}`;
    case "truck":
      return `truck:${p.truck_id}:${p.position}`;
  }
}

export function formatId(prefix: "plt" | "tsk" | "trk" | "ord", n: number): string {
  return `${prefix}-${String(n).padStart(6, "0")}`;
}
