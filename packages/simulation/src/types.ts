import type { DomainEvent, SimulationCommand } from "@warehouse-one/contracts";
import type { RngState } from "./rng";

export const ENGINE_VERSION = "0.1.0";
export const SNAPSHOT_VERSION = 1;

export interface LocationConfig {
  readonly id: string;
  readonly zone: string;
  /** Maximum units (pallet positions) the location can hold across all SKUs. */
  readonly capacity: number;
  /** Floor-plan position in metres, used only by rendering adapters. */
  readonly position: { readonly x: number; readonly z: number };
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
