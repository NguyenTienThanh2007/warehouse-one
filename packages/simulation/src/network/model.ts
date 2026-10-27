import type { CargoLine, LinehaulStatus, TransferStatus } from "@warehouse-one/contracts";
import type { Point2 } from "../types";

/**
 * Phase 5 logistics network: several sites connected by roads, a fleet of line-haul trucks, and
 * transfers of pallets between sites.
 *
 * The distribution centre (the site marked `primary`) is not modelled again here: it is the
 * existing facility simulation (`config.facility`, `state.ops`). A line-haul truck that reaches its
 * gate is handed to that simulation as an ordinary inbound truck or outbound order, and takes over
 * again when that truck departs. The other sites keep pallet counts per SKU (no rack positions).
 *
 * Units follow the operations model: integer millimetres and ticks in state; metres and radians
 * only in config (layout master data, read by renderers and pose functions).
 */

export type SiteKind =
  "distribution_center" | "cross_dock" | "container_terminal" | "fleet_depot" | "gateway";

/**
 * A place where one truck stands: a dock door or loading stand ("door"), a waiting stall
 * ("staging"), a home parking stall ("parking") or a maintenance bay ("service").
 */
export type StandKind = "door" | "staging" | "parking" | "service";

export interface StandConfig {
  readonly id: string;
  readonly kind: StandKind;
  /** Road node in front of the stand; trucks manoeuvre between it and the stand. */
  readonly approach_node: string;
  /** Centre of the truck (tractor + trailer) when it stands here (m). */
  readonly position: Point2;
  /** Direction the truck's front points when it stands here (radians, LocationConfig.yaw convention). */
  readonly yaw: number;
  /** Doors only: preferred use (cross-docks receive on one side and dispatch from the other). */
  readonly role?: "inbound" | "outbound";
}

/** A building on a site (rendering and inspection only). */
export interface SiteBuildingConfig {
  readonly id: string;
  readonly label: string;
  readonly style: "cross_dock" | "cfs_shed" | "workshop" | "office" | "gatehouse";
  readonly min: Point2;
  readonly max: Point2;
  readonly height: number;
}

export interface ContainerYardConfig {
  /** Maximum containers stacked in the yard. */
  readonly capacity: number;
  readonly opening: number;
  /** Pallets unpacked from one container (devanning). */
  readonly pallets_per_container: number;
  readonly devan_ticks: number;
  /** A container is devanned only while the site holds fewer pallets than this. */
  readonly devan_below: number;
  /** A vessel discharges containers every `interval_ticks` (at `phase_ticks`). */
  readonly vessel: {
    readonly interval_ticks: number;
    readonly phase_ticks: number;
    readonly min: number;
    readonly max: number;
  };
  /** Stack blocks for rendering: bays along x × rows along z × tiers. */
  readonly blocks: readonly {
    readonly id: string;
    readonly origin: Point2;
    readonly bays: number;
    readonly rows: number;
    readonly tiers: number;
  }[];
}

export interface SiteConfig {
  readonly id: string;
  readonly kind: SiteKind;
  readonly name: string;
  /** Paved site area (m). */
  readonly bounds: { readonly min: Point2; readonly max: Point2 };
  /** Road node where trucks enter and leave the site. */
  readonly gate_node: string;
  readonly stands: readonly StandConfig[];
  readonly buildings: readonly SiteBuildingConfig[];
  /** Pallets the site can hold (non-primary sites; 0 for the DC, whose capacity is its racking). */
  readonly pallet_capacity: number;
  readonly opening_stock?: readonly CargoLine[];
  /** Ticks to load or unload one pallet at a door of this site. */
  readonly handling_ticks_per_pallet: number;
  readonly containers?: ContainerYardConfig;
}

export interface RoadNodeConfig {
  readonly id: string;
  readonly position: Point2;
}

/** A two-way road segment between two nodes; trucks keep right. */
export interface RoadConfig {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "arterial" | "service";
}

export interface LinehaulVehicleConfig {
  readonly id: string;
  readonly label: string;
  /** Parking stand at the fleet depot where the truck starts and returns when idle. */
  readonly home_stand: string;
}

/** A scheduled flow: every `interval_ticks` (at `phase_ticks`) plan one transfer if possible. */
export interface LaneConfig {
  readonly id: string;
  readonly from_site: string;
  readonly to_site: string;
  readonly interval_ticks: number;
  readonly phase_ticks: number;
  readonly min_pallets: number;
  readonly max_pallets: number;
  /** Lane is skipped while it already has this many unfinished transfers. */
  readonly max_open: number;
}

export interface NetworkConfig {
  readonly name: string;
  /** The site whose operations are `config.facility` (the detailed DC simulation). */
  readonly primary_site: string;
  readonly sites: readonly SiteConfig[];
  readonly nodes: readonly RoadNodeConfig[];
  readonly roads: readonly RoadConfig[];
  readonly vehicles: readonly LinehaulVehicleConfig[];
  readonly lanes: readonly LaneConfig[];
  /** A truck is serviced at a depot service bay after driving this far (mm). */
  readonly service_interval_mm: number;
  readonly service_ticks: number;
  /** Ticks a truck spends outside the modelled world after passing the gateway. */
  readonly off_network_ticks: number;
}

// ---------------------------------------------------------------------------------------------
// State

/** Non-terminal transfer states; delivered and cancelled transfers leave state (history is events). */
export type ActiveTransferStatus = Exclude<TransferStatus, "delivered" | "cancelled">;

export interface TransferState {
  readonly id: string;
  readonly lane_id: string | null;
  readonly from_site: string;
  readonly to_site: string;
  readonly lines: readonly CargoLine[];
  readonly status: ActiveTransferStatus;
  readonly vehicle_id: string | null;
  readonly created_tick: number;
  readonly correlation_id: string;
}

/**
 * What a truck is trying to do. Docked at a staging stall it waits (and retries) for that; at the
 * end of a route or manoeuvre it acts on it.
 */
export type Intent =
  /** Dock at `target_stand` (a door) and load the transfer's pallets. */
  | "load"
  /** Dock at `target_stand` (a door) and unload. */
  | "unload"
  /** Loaded: leave for the destination (waits where it is until a stand there is free). */
  | "depart"
  /** Return to the home parking stall. */
  | "park"
  /** Go to a depot service bay. */
  | "service"
  /** Enter the distribution centre at its gate (handed to the facility simulation). */
  | "enter_dc"
  /** Leave the modelled world at the gateway (last-mile delivery). */
  | "exit";

export interface LinehaulState {
  readonly id: string;
  readonly status: LinehaulStatus;
  /** Road node the truck is at; while it stands somewhere, that stand's approach node. */
  readonly node: string;
  /** The node it came from (heading on arrival), or null. */
  readonly prev_node: string | null;
  /** Remaining nodes; `route[0]` is the next one. */
  readonly route: readonly string[];
  /** Distance driven from `node` towards `route[0]`. */
  readonly progress_mm: number;
  /** Site the truck is at, or null on the road. */
  readonly site_id: string | null;
  /** Stand the truck occupies (or is docking into / undocking from). */
  readonly stand_id: string | null;
  /** Stand reserved at the end of the current route. */
  readonly target_stand: string | null;
  readonly intent: Intent | null;
  /** Docking / undocking / DC-exit manoeuvre time left. */
  readonly manoeuvre_ticks_left: number;
  readonly transfer_id: string | null;
  /** Pallets on board. */
  readonly cargo: readonly CargoLine[];
  /** Pallets handled so far in the current loading or unloading. */
  readonly handled: number;
  /** Countdown to the next pallet handled, to the end of service, or to the next retry. */
  readonly timer_ticks: number;
  /** The facility simulation's truck while `at_dc`. */
  readonly dc_truck_id: string | null;
  /** That truck's yard slot and dock (the dock gives the exit pose after it departs). */
  readonly dc_yard_slot: number | null;
  readonly dc_dock_id: string | null;
  readonly odometer_mm: number;
  readonly service_odometer_mm: number;
  readonly status_since_tick: number;
  /**
   * Site where the truck waits on a staging stall while idle (`linehaul.set_standby`). Absent:
   * it returns to its home stall at the depot. Absent unless set, so runs that never use it keep
   * their state shape and hashes.
   */
  readonly standby_site?: string;
}

export interface SiteState {
  /** Pallets on hand per SKU (zero entries are never stored). */
  readonly stock: Readonly<Record<string, number>>;
  /** Pallets promised to planned outbound transfers, per SKU (≤ stock). */
  readonly allocated: Readonly<Record<string, number>>;
  /** Pallets promised by inbound transfers (reserved capacity). */
  readonly incoming: number;
  readonly containers: number;
  readonly devan_ticks_left: number;
  /** SKU of the container being devanned. */
  readonly devan_sku: string | null;
  /** stand id -> truck holding or approaching it. */
  readonly stands: Readonly<Record<string, string | null>>;
  /** Pallets received and dispatched by transfers since the run started. */
  readonly received: number;
  readonly dispatched: number;
}

export interface NetworkState {
  readonly sites: Readonly<Record<string, SiteState>>;
  readonly vehicles: Readonly<Record<string, LinehaulState>>;
  readonly transfers: Readonly<Record<string, TransferState>>;
  readonly next_transfer: number;
}

// ---------------------------------------------------------------------------------------------
// Rules and timings (documented in docs/phases/PHASE_5.md).

/** Speeds in mm per 100 ms tick: 40 km/h on arterial roads, 20 km/h on site lanes. */
export const ROAD_SPEED_MM_PER_TICK = { arterial: 1100, service: 550 } as const;
/** Minimum gap before a truck may enter a road segment behind another one going the same way. */
export const HEADWAY_MM = 24_000;
export const DOCK_TICKS = 70;
export const UNDOCK_TICKS = 50;
/** The DC's truck is held in the yard this long while the line-haul truck reverses into its slot. */
export const DC_ENTER_TICKS = 90;
export const DC_LEAVE_TICKS = 50;
/** A truck waiting for a door or for DC admission re-checks this often. */
export const RETRY_TICKS = 50;
/** An outbound DC transfer that cannot be admitted for this long is cancelled. */
export const DC_ORIGIN_MAX_WAIT_TICKS = 6000;
/** Pallets per line-haul trailer (same trailer as the DC's trucks). */
export { TRUCK_CAPACITY as TRAILER_CAPACITY } from "@warehouse-one/contracts";

export function formatTransferId(n: number): string {
  return `xfr-${String(n).padStart(6, "0")}`;
}

export function cargoTotal(lines: readonly CargoLine[]): number {
  return lines.reduce((n, l) => n + l.quantity, 0);
}
