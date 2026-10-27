import type { SimulationCommand, TransferStatusChangedPayload } from "@warehouse-one/contracts";
import type { z } from "zod";
import {
  cargoTotal,
  checkInvariants,
  stateHash,
  step,
  type CommandRejection,
  type SimulationConfig,
  type SimulationState,
} from "@warehouse-one/simulation";

/**
 * Fleet metrics of one simulated trajectory. Every value is computed from the engine's own events
 * and state over the evaluation horizon, by the same rules for the baseline and every candidate.
 * Units are part of the name: seconds and kilometres of simulated time and distance.
 */
export interface FleetMetrics {
  /** Mean time from a transfer being planned to a truck starting to load it. */
  readonly pickup_wait_s: number | null;
  readonly pickup_wait_p90_s: number | null;
  /** Distance driven without cargo: to a pickup, to a standby stall, home or to service. */
  readonly empty_km: number;
  readonly loaded_km: number;
  readonly transfers_planned: number;
  readonly pallets_planned: number;
  readonly transfers_delivered: number;
  readonly pallets_delivered: number;
  readonly transfers_cancelled: number;
  /** Transfers planned in the horizon that no truck had started loading by its end. */
  readonly transfers_waiting_end: number;
  /** Mean time from planned to delivered, for transfers planned and delivered in the horizon. */
  readonly lead_time_s: number | null;
}

export type MetricKey = keyof FleetMetrics;

export interface MetricInfo {
  readonly key: MetricKey;
  readonly label: string;
  readonly unit: "s" | "km" | "transfers" | "pallets";
  /** Which direction is an improvement; "info" metrics describe the workload, not the plan. */
  readonly better: "lower" | "higher" | "info";
  readonly definition: string;
}

/** The objective every strategy optimises in this version. */
export const PRIMARY_METRIC: MetricKey = "pickup_wait_s";

export const METRICS: readonly MetricInfo[] = [
  {
    key: "pickup_wait_s",
    label: "Mean pickup wait",
    unit: "s",
    better: "lower",
    definition:
      "Mean simulated time from a transfer being planned to a truck starting to load it. Transfers still waiting at the end of the horizon count until the end (a lower bound).",
  },
  {
    key: "pickup_wait_p90_s",
    label: "Pickup wait, 90th percentile",
    unit: "s",
    better: "lower",
    definition: "90th percentile of the same waits (nearest rank).",
  },
  {
    key: "empty_km",
    label: "Empty driving",
    unit: "km",
    better: "lower",
    definition:
      "Distance line-haul trucks drove without cargo: to pickups, to standby stalls, home and to service.",
  },
  {
    key: "loaded_km",
    label: "Loaded driving",
    unit: "km",
    better: "info",
    definition: "Distance driven with cargo on board.",
  },
  {
    key: "transfers_planned",
    label: "Transfers planned",
    unit: "transfers",
    better: "info",
    definition:
      "Transfers created in the horizon (the workload). Lanes draw quantities at random, so this can differ slightly between plans.",
  },
  {
    key: "pallets_planned",
    label: "Pallets planned",
    unit: "pallets",
    better: "info",
    definition: "Pallets on the transfers created in the horizon.",
  },
  {
    key: "transfers_delivered",
    label: "Transfers delivered",
    unit: "transfers",
    better: "higher",
    definition: "Transfers delivered in the horizon (including ones planned before it started).",
  },
  {
    key: "pallets_delivered",
    label: "Pallets delivered",
    unit: "pallets",
    better: "higher",
    definition: "Pallets on the transfers delivered in the horizon.",
  },
  {
    key: "transfers_cancelled",
    label: "Transfers cancelled",
    unit: "transfers",
    better: "lower",
    definition:
      "Transfers the network gave up in the horizon (a DC origin that never admitted the truck).",
  },
  {
    key: "transfers_waiting_end",
    label: "Still waiting at the end",
    unit: "transfers",
    better: "lower",
    definition: "Transfers planned in the horizon that no truck had started loading by its end.",
  },
  {
    key: "lead_time_s",
    label: "Mean lead time",
    unit: "s",
    better: "lower",
    definition:
      "Mean time from planned to delivered, for transfers both planned and delivered in the horizon.",
  },
];

export const metricInfo = (key: MetricKey): MetricInfo =>
  METRICS.find((m) => m.key === key) as MetricInfo;

export interface Trajectory {
  readonly metrics: FleetMetrics;
  /** Engine invariant violations seen at any check point (empty = healthy). */
  readonly violations: readonly string[];
  /** Commands the engine refused (a plan whose commands are refused is infeasible). */
  readonly rejections: readonly CommandRejection[];
  readonly end_tick: number;
  readonly end_state_hash: string;
}

export interface RunHooks {
  readonly signal?: AbortSignal;
  /** Called with ticks simulated so far (of this trajectory). */
  readonly onTicks?: (ticks: number) => void;
  /** Ticks between cooperative yields to the caller's event loop (default 2,000). */
  readonly yieldEvery?: number;
}

/** Engine invariants are checked this often and at the end (the engine is the authority). */
const INVARIANT_EVERY = 1_000;

export class EvaluationAborted extends Error {
  constructor() {
    super("evaluation cancelled");
    this.name = "EvaluationAborted";
  }
}

const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface TransferTrack {
  planned?: number;
  loading?: number;
  delivered?: number;
  pallets: number;
}

/**
 * Run the engine forward from `start` for `horizon` ticks, applying `commands` on the first tick,
 * and measure the fleet. `start` is never modified (`step()` is pure and copy-on-write), so the
 * same frozen snapshot can seed any number of trajectories, one after another or concurrently.
 */
export async function simulate(
  config: SimulationConfig,
  start: SimulationState,
  commands: readonly SimulationCommand[],
  horizon: number,
  hooks: RunHooks = {},
): Promise<Trajectory> {
  if (!Number.isInteger(horizon) || horizon < 1) throw new RangeError("horizon must be ≥ 1 tick");
  const tickMs = config.tick_ms;
  const yieldEvery = hooks.yieldEvery ?? 2_000;
  const tracks = new Map<string, TransferTrack>();
  const violations = new Set<string>();
  const rejections: CommandRejection[] = [];
  let emptyMm = 0;
  let loadedMm = 0;
  let delivered = 0;
  let palletsDelivered = 0;
  let cancelled = 0;
  let s = start;

  for (let i = 0; i < horizon; i++) {
    if (hooks.signal?.aborted) throw new EvaluationAborted();
    const prev = s;
    const r = step(config, s, i === 0 ? [...commands] : []);
    s = r.state;
    rejections.push(...r.rejections);
    for (const e of r.events) {
      if (e.event_type !== "transfer.status_changed") continue;
      const p = e.payload as z.infer<typeof TransferStatusChangedPayload>;
      const t = tracks.get(p.transfer_id) ?? { pallets: cargoTotal(p.lines) };
      if (p.to === "planned") t.planned = s.tick;
      else if (p.to === "loading") t.loading = s.tick;
      else if (p.to === "delivered") {
        t.delivered = s.tick;
        delivered += 1;
        palletsDelivered += t.pallets;
      } else if (p.to === "cancelled") cancelled += 1;
      tracks.set(p.transfer_id, t);
    }
    const before = prev.network?.vehicles;
    for (const v of Object.values(s.network?.vehicles ?? {})) {
      const moved = v.odometer_mm - (before?.[v.id]?.odometer_mm ?? v.odometer_mm);
      if (moved <= 0) continue;
      if (v.cargo.length > 0) loadedMm += moved;
      else emptyMm += moved;
    }
    if ((i + 1) % INVARIANT_EVERY === 0 || i === horizon - 1)
      for (const v of checkInvariants(config, s)) violations.add(v);
    if ((i + 1) % yieldEvery === 0) {
      hooks.onTicks?.(i + 1);
      await yieldNow();
    }
  }
  hooks.onTicks?.(horizon);

  const end = s.tick;
  const planned = [...tracks.values()].filter((t) => t.planned !== undefined);
  const waits = planned.map((t) => ((t.loading ?? end) - (t.planned as number)) * (tickMs / 1000));
  const leads = planned
    .filter((t) => t.delivered !== undefined)
    .map((t) => ((t.delivered as number) - (t.planned as number)) * (tickMs / 1000));
  return {
    metrics: {
      pickup_wait_s: mean(waits),
      pickup_wait_p90_s: percentile(waits, 0.9),
      empty_km: round(emptyMm / 1e6, 3),
      loaded_km: round(loadedMm / 1e6, 3),
      transfers_planned: planned.length,
      pallets_planned: planned.reduce((n, t) => n + t.pallets, 0),
      transfers_delivered: delivered,
      pallets_delivered: palletsDelivered,
      transfers_cancelled: cancelled,
      transfers_waiting_end: planned.filter((t) => t.loading === undefined).length,
      lead_time_s: mean(leads),
    },
    violations: [...violations],
    rejections,
    end_tick: end,
    end_state_hash: stateHash(config, s),
  };
}

export function round(x: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function mean(xs: readonly number[]): number | null {
  return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

/** Nearest-rank percentile; null for no data. */
function percentile(xs: readonly number[], q: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number);
}
