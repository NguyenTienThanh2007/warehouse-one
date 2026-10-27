import {
  ENGINE_VERSION,
  hashValue,
  isIdle,
  standbyCapacity,
  stateHash,
  type SimulationConfig,
  type SimulationState,
} from "@warehouse-one/simulation";
import { currentPlan } from "./plan";

/**
 * Identity of the operational state an evaluation started from. A proposal keeps it, so anyone can
 * tell which inputs produced its numbers, and approval can tell whether the live run has moved on.
 */
export interface SourceRef {
  readonly simulation_id: string;
  readonly tick: number;
  readonly sim_time_ms: number;
  /** Simulated wall clock at that tick (config epoch + elapsed), ISO 8601. */
  readonly simulated_at: string;
  /** Fingerprint of {config, state}: the snapshot's own hash. */
  readonly state_hash: string;
  readonly config_hash: string;
  /** Fingerprint of the fleet and its standby settings: what a standby plan depends on. */
  readonly fleet_fingerprint: string;
  readonly engine_version: string;
}

/** The live run, as the approving operator sees it. */
export interface LiveContext {
  readonly simulation_id: string;
  readonly config_hash: string;
  readonly tick: number;
  readonly fleet_fingerprint: string;
}

export const fleetFingerprint = (state: SimulationState): string => hashValue(currentPlan(state));

export const configHash = (config: SimulationConfig): string => hashValue(config);

export function sourceRef(config: SimulationConfig, state: SimulationState): SourceRef {
  const simTimeMs = state.tick * config.tick_ms;
  return {
    simulation_id: config.simulation_id,
    tick: state.tick,
    sim_time_ms: simTimeMs,
    simulated_at: new Date(Date.parse(config.epoch) + simTimeMs).toISOString(),
    state_hash: stateHash(config, state),
    config_hash: configHash(config),
    fleet_fingerprint: fleetFingerprint(state),
    engine_version: ENGINE_VERSION,
  };
}

export function liveContext(config: SimulationConfig, state: SimulationState): LiveContext {
  return {
    simulation_id: config.simulation_id,
    config_hash: configHash(config),
    tick: state.tick,
    fleet_fingerprint: fleetFingerprint(state),
  };
}

/** A proposal is valid for this much simulated time after the state it was computed from. */
export const MAX_AGE_TICKS = 18_000;

export type Freshness =
  | { readonly fresh: true; readonly age_ticks: number }
  | {
      readonly fresh: false;
      readonly reason: "other_run" | "run_restarted" | "too_old" | "fleet_changed";
      readonly message: string;
    };

/**
 * Is a proposal computed from `source` still about the live run? The same rule runs in the API
 * (twin/lifecycle.py), which is the one that decides approval and execution.
 */
export function freshness(
  source: Pick<SourceRef, "simulation_id" | "config_hash" | "tick" | "fleet_fingerprint">,
  live: LiveContext,
  maxAgeTicks = MAX_AGE_TICKS,
): Freshness {
  if (live.simulation_id !== source.simulation_id || live.config_hash !== source.config_hash)
    return {
      fresh: false,
      reason: "other_run",
      message: "The live simulation is a different run or scenario than the one evaluated.",
    };
  if (live.tick < source.tick)
    return {
      fresh: false,
      reason: "run_restarted",
      message: "The live run is earlier than the evaluated state: it was reset or reloaded.",
    };
  if (live.fleet_fingerprint !== source.fleet_fingerprint)
    return {
      fresh: false,
      reason: "fleet_changed",
      message: "The fleet's standby settings changed after the evaluation.",
    };
  const age = live.tick - source.tick;
  if (age > maxAgeTicks)
    return {
      fresh: false,
      reason: "too_old",
      message: `The evaluation is ${Math.round(age / 600)} simulated minutes old (limit ${maxAgeTicks / 600}).`,
    };
  return { fresh: true, age_ticks: age };
}

/** Transfers per hour that each site sends, from the configured lanes (the demand model). */
export interface SiteDemand {
  readonly site_id: string;
  readonly site_name: string;
  readonly transfers_per_hour: number;
  /** Transfers waiting for a truck at this site now. */
  readonly backlog: number;
  readonly standby_capacity: number;
}

export function siteDemand(config: SimulationConfig, state: SimulationState): SiteDemand[] {
  const net = config.network;
  if (!net) return [];
  const hourTicks = 3_600_000 / config.tick_ms;
  return net.sites.map((site) => ({
    site_id: site.id,
    site_name: site.name,
    transfers_per_hour:
      Math.round(
        net.lanes
          .filter((l) => l.from_site === site.id && l.interval_ticks > 0)
          .reduce((r, l) => r + hourTicks / l.interval_ticks, 0) * 10,
      ) / 10,
    backlog: Object.values(state.network?.transfers ?? {}).filter(
      (t) => t.from_site === site.id && t.status === "planned",
    ).length,
    standby_capacity: standbyCapacity(net, site.id),
  }));
}

/** Measured now, from the live state: what the workspace shows as operational context. */
export interface FleetSnapshot {
  readonly trucks: number;
  readonly idle: number;
  readonly by_status: Readonly<Record<string, number>>;
  readonly open_transfers: number;
  readonly waiting_for_truck: number;
  readonly standby: Readonly<Record<string, number>>;
}

export function fleetSnapshot(state: SimulationState): FleetSnapshot {
  const vehicles = Object.values(state.network?.vehicles ?? {});
  const transfers = Object.values(state.network?.transfers ?? {});
  const by: Record<string, number> = {};
  const standby: Record<string, number> = {};
  for (const v of vehicles) {
    by[v.status] = (by[v.status] ?? 0) + 1;
    const key = v.standby_site ?? "home";
    standby[key] = (standby[key] ?? 0) + 1;
  }
  return {
    trucks: vehicles.length,
    idle: vehicles.filter(isIdle).length,
    by_status: by,
    open_transfers: transfers.length,
    waiting_for_truck: transfers.filter((t) => t.status === "planned").length,
    standby,
  };
}
