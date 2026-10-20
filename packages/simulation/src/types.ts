import type { DomainEvent, SimulationCommand } from "@warehouse-one/contracts";
import type { RngState } from "./rng";

export const ENGINE_VERSION = "0.1.0";
export const SNAPSHOT_VERSION = 1;

export interface LocationConfig {
  readonly id: string;
  readonly zone: string;
  /** Maximum units (pallet positions) the location can hold across all SKUs. */
  readonly capacity: number;
  /** Floor-plan position in metres (bay centre), used only by rendering adapters. */
  readonly position: { readonly x: number; readonly z: number };
  /**
   * Rotation about the vertical axis in radians; the bay's pick face points along
   * (sin(yaw), cos(yaw)). Rendering only. Default 0 (pick face towards +z).
   */
  readonly yaw?: number;
}

export interface SkuConfig {
  readonly id: string;
  readonly name: string;
}

export interface SyntheticWorkloadConfig {
  /** Probability per tick of a synthetic inbound receipt. */
  readonly inbound_probability: number;
  /** Probability per tick of a synthetic internal move. */
  readonly move_probability: number;
  readonly max_quantity: number;
}

export interface SimulationConfig {
  readonly simulation_id: string;
  readonly seed: string;
  /** Fixed simulation step in milliseconds of simulated time. */
  readonly tick_ms: number;
  /** UTC instant corresponding to simulation_time_ms = 0 (ISO-8601, millisecond precision). */
  readonly epoch: string;
  readonly locations: readonly LocationConfig[];
  readonly skus: readonly SkuConfig[];
  /** Optional seeded workload generator for demos and benchmarks. Disabled when absent. */
  readonly synthetic_workload?: SyntheticWorkloadConfig;
  /**
   * Physical facility master data (building, racking spec, docks, equipment). It does not affect
   * simulation rules in Phase 1; renderers and inspectors read it so they never invent geometry
   * or assets. Equipment becomes stateful (moving, tasked) in Phase 2.
   */
  readonly facility?: FacilityConfig;
}

export interface Point2 {
  readonly x: number;
  readonly z: number;
}

export interface RackSpec {
  /** Clear bay width along the beam, centre-to-centre of uprights (m). */
  readonly bay_width: number;
  /** Rack depth front-to-back (m). */
  readonly depth: number;
  /** Vertical pitch between beam levels (m); level 0 stores on the floor. */
  readonly level_height: number;
  /** Pallet positions per level; levels = ceil(capacity / positions_per_level). */
  readonly positions_per_level: number;
}

export interface DockConfig {
  readonly id: string;
  /** Centre of the door opening on the wall line. */
  readonly position: Point2;
  /** Outward-facing direction of the door (radians, same convention as LocationConfig.yaw). */
  readonly yaw: number;
}

export type EquipmentKind = "counterbalance_forklift" | "reach_truck" | "truck";

export interface EquipmentConfig {
  readonly id: string;
  readonly kind: EquipmentKind;
  readonly label: string;
  /** Parking position and heading. Static in Phase 1. */
  readonly position: Point2;
  readonly yaw: number;
  /** Rated capacity in kg (vehicle spec, informational). */
  readonly rated_capacity_kg: number;
  /** For trucks: the dock they are reversed onto. */
  readonly dock_id?: string;
}

export interface FacilityConfig {
  readonly name: string;
  /** Interior footprint of the building (m). */
  readonly building: {
    readonly min: Point2;
    readonly max: Point2;
    readonly height: number;
  };
  /** Outdoor paved area (yard) including the building footprint (m). */
  readonly site: { readonly min: Point2; readonly max: Point2 };
  readonly rack: RackSpec;
  readonly docks: readonly DockConfig[];
  readonly equipment: readonly EquipmentConfig[];
}

/** location_id -> sku -> quantity. Zero quantities are never stored. */
export type InventoryTable = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** Authoritative, JSON-serializable simulation state. Treat as immutable. */
export interface SimulationState {
  readonly tick: number;
  /** Sequence number of the last emitted event (0 = none yet). */
  readonly sequence: number;
  readonly rng: RngState;
  readonly inventory: InventoryTable;
  /** aggregate_id (sku) -> last aggregate_version emitted. */
  readonly aggregate_versions: Readonly<Record<string, number>>;
}

export type RejectionCode =
  | "INVALID_COMMAND"
  | "UNKNOWN_LOCATION"
  | "UNKNOWN_SKU"
  | "INSUFFICIENT_STOCK"
  | "CAPACITY_EXCEEDED";

export interface CommandRejection {
  readonly command_id: string;
  readonly tick: number;
  readonly code: RejectionCode;
  readonly message: string;
}

export interface StepResult {
  readonly state: SimulationState;
  readonly events: readonly DomainEvent[];
  readonly rejections: readonly CommandRejection[];
}

export interface LoggedCommand {
  /** The tick at which the command was applied. */
  readonly tick: number;
  readonly command: SimulationCommand;
}
