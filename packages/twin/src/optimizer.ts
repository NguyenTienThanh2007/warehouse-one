import {
  checkInvariants,
  deterministicUuid,
  hashValue,
  stateHash,
  standbyCapacity,
  standbySites,
  type NetworkConfig,
  type SimulationConfig,
  type SimulationState,
  type Snapshot,
} from "@warehouse-one/simulation";
import { siteDemand, sourceRef, type SiteDemand, type SourceRef } from "./context";
import { compareMetrics, type MetricDelta } from "./deltas";
import { inlineExecutor, type TrajectoryExecutor } from "./executor";
import {
  EvaluationAborted,
  PRIMARY_METRIC,
  round,
  type FleetMetrics,
  type Trajectory,
} from "./metrics";
import {
  currentPlan,
  makePlan,
  planChanges,
  planCommands,
  planCounts,
  validatePlan,
  type ConstraintResult,
  type PlanChange,
  type StandbyPlan,
} from "./plan";

/**
 * Fleet standby strategy, version 1: where should idle line-haul trucks wait so that the next
 * transfers are picked up sooner?
 *
 * 1. Demand model: transfers per hour that each site sends, from the configured lanes.
 * 2. Candidates: demand-proportional allocations (D'Hondt, capped by each site's standby capacity)
 *    for several fleet shares, and the busiest origin filled to capacity.
 * 3. Every candidate is simulated from the same frozen snapshot for the same horizon as the
 *    baseline (the plan in effect), by the engine itself, applying the plan through the same
 *    `linehaul.set_standby` commands an approved proposal would submit.
 * 4. Local search: single-truck moves around the best plan so far, first improvement, until the
 *    evaluation budget is spent.
 * 5. A plan is recommended only if every hard constraint holds and it beats the baseline's mean
 *    pickup wait by at least `min_improvement_pct` % and `min_improvement_s` seconds.
 *
 * A heuristic over a bounded budget: the result is the best plan evaluated, not a proven optimum.
 */
export const STANDBY_STRATEGY = { id: "fleet-standby", version: "1.0.0" } as const;

export interface OptimizeOptions {
  /** Simulated ticks every plan is run for (100 ms each). */
  readonly horizon_ticks: number;
  /** Simulations allowed, the baseline included. */
  readonly max_evaluations: number;
  readonly min_improvement_pct: number;
  readonly min_improvement_s: number;
  /** A candidate must deliver at least this share of the baseline's pallets (service level). */
  readonly service_floor_pct: number;
}

export const DEFAULT_OPTIONS: OptimizeOptions = {
  horizon_ticks: 18_000,
  max_evaluations: 8,
  min_improvement_pct: 5,
  min_improvement_s: 2,
  service_floor_pct: 95,
};

export const OPTION_LIMITS = {
  horizon_ticks: { min: 3_000, max: 36_000 },
  max_evaluations: { min: 2, max: 12 },
} as const;

/** Wall-clock limit for one optimisation, whatever the options. */
export const TIME_LIMIT_MS = 120_000;

export type TwinErrorCode =
  | "NO_NETWORK"
  | "NO_FLEET"
  | "INVALID_SNAPSHOT"
  | "INVALID_OPTIONS"
  | "INVALID_PLAN"
  | "EVALUATION_TIMEOUT"
  | "CANCELLED";

export class TwinError extends Error {
  constructor(
    readonly code: TwinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TwinError";
  }
}

export type CandidateOrigin = "proportional" | "busiest_origin" | "local_search" | "user";
export type Verdict = "recommended" | "improves" | "no_better" | "infeasible";

export interface CandidateResult {
  readonly candidate_id: string;
  readonly label: string;
  readonly origin: CandidateOrigin;
  readonly plan: StandbyPlan;
  readonly changes: readonly PlanChange[];
  readonly constraints: readonly ConstraintResult[];
  readonly feasible: boolean;
  /** Null when a plan-stage constraint failed (the plan was never simulated). */
  readonly metrics: FleetMetrics | null;
  readonly deltas: readonly MetricDelta[];
  readonly verdict: Verdict;
  readonly rank: number | null;
  readonly reasons: readonly string[];
  readonly end_state_hash: string | null;
}

export interface Recommendation {
  readonly candidate_id: string;
  readonly summary: string;
  readonly reasons: readonly string[];
}

export interface Evaluation {
  readonly evaluation_id: string;
  readonly kind: "optimization" | "what_if";
  readonly strategy: typeof STANDBY_STRATEGY;
  readonly source: SourceRef;
  readonly options: OptimizeOptions;
  readonly objective: { readonly metric: typeof PRIMARY_METRIC; readonly direction: "minimize" };
  readonly demand: readonly SiteDemand[];
  readonly baseline: {
    readonly plan: StandbyPlan;
    readonly metrics: FleetMetrics;
    readonly constraints: readonly ConstraintResult[];
    readonly end_state_hash: string;
  };
  readonly candidates: readonly CandidateResult[];
  readonly recommendation: Recommendation | null;
  /** Why nothing is recommended (null when something is). */
  readonly no_recommendation_reason: string | null;
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  readonly search: {
    readonly simulations: number;
    readonly budget: number;
    readonly plans_considered: number;
    readonly exhausted_budget: boolean;
  };
  /** Wall-clock facts about this computation; not part of the deterministic result. */
  readonly runtime: { readonly elapsed_ms: number; readonly ticks_simulated: number };
}

export interface Progress {
  /** What is being computed now. */
  readonly stage: "validating" | "simulating" | "searching" | "ranking" | "done";
  /** Simulations whose results the evaluation used so far. */
  readonly simulations_done: number;
  /** Simulations in progress right now (several when an executor runs them in parallel). */
  readonly simulations_running: number;
  readonly simulations_budget: number;
  readonly label: string;
  /** 0..1 over the whole evaluation. */
  readonly fraction: number;
}

export interface EvaluateHooks {
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: Progress) => void;
  readonly yieldEvery?: number;
  /** Wall clock for `runtime` only (performance.now in the browser and Node). */
  readonly now?: () => number;
  /** Where trajectories run (default: inline, one after another). Results never depend on it. */
  readonly executor?: TrajectoryExecutor;
}

// ---------------------------------------------------------------------------------------------

export function checkOptions(partial: Partial<OptimizeOptions> = {}): OptimizeOptions {
  const o = { ...DEFAULT_OPTIONS, ...partial };
  const problems: string[] = [];
  const intIn = (k: keyof typeof OPTION_LIMITS) => {
    const { min, max } = OPTION_LIMITS[k];
    if (!Number.isInteger(o[k]) || o[k] < min || o[k] > max)
      problems.push(`${k} must be an integer in [${min}, ${max}]`);
  };
  intIn("horizon_ticks");
  intIn("max_evaluations");
  if (!(o.min_improvement_pct >= 0 && o.min_improvement_pct <= 100))
    problems.push("min_improvement_pct must be within [0, 100]");
  if (!(o.min_improvement_s >= 0)) problems.push("min_improvement_s must be ≥ 0");
  if (!(o.service_floor_pct >= 0 && o.service_floor_pct <= 100))
    problems.push("service_floor_pct must be within [0, 100]");
  if (problems.length) throw new TwinError("INVALID_OPTIONS", problems.join("; "));
  return o;
}

/** Verify a snapshot before evaluating it: integrity, invariants, a network with a fleet. */
export function checkSnapshot(snapshot: Snapshot): {
  config: SimulationConfig;
  state: SimulationState;
} {
  const { config, state } = snapshot;
  if (!config?.network || !state?.network)
    throw new TwinError(
      "NO_NETWORK",
      "This scenario has a single site and no line-haul fleet: open the logistics park.",
    );
  if (Object.keys(state.network.vehicles).length === 0)
    throw new TwinError("NO_FLEET", "The network has no line-haul trucks to plan for.");
  if (stateHash(config, state) !== snapshot.state_hash)
    throw new TwinError("INVALID_SNAPSHOT", "The snapshot's hash does not match its content.");
  const violations = checkInvariants(config, state);
  if (violations.length)
    throw new TwinError("INVALID_SNAPSHOT", `The snapshot violates invariants: ${violations[0]}`);
  return { config, state };
}

// ---------------------------------------------------------------------------------------------
// Candidate generation

/** D'Hondt: `k` trucks over sites by demand, never above a site's standby capacity. */
export function proportionalCounts(
  net: NetworkConfig,
  demand: readonly SiteDemand[],
  k: number,
): Map<string, number> {
  const eligible = standbySites(net)
    .map((s) => ({
      id: s.id,
      rate: demand.find((d) => d.site_id === s.id)?.transfers_per_hour ?? 0,
      cap: standbyCapacity(net, s.id),
    }))
    .filter((s) => s.rate > 0);
  const counts = new Map<string, number>();
  for (let seat = 0; seat < k; seat++) {
    let best: (typeof eligible)[number] | null = null;
    for (const s of eligible) {
      const n = counts.get(s.id) ?? 0;
      if (n >= s.cap) continue;
      if (!best || s.rate / (n + 1) > best.rate / ((counts.get(best.id) ?? 0) + 1)) best = s;
    }
    if (!best) break;
    counts.set(best.id, (counts.get(best.id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Turn trucks-per-site into a plan, changing as few trucks as possible: trucks already standing by
 * at a site keep their place while it has room, trucks at home fill the rest (lowest id first).
 */
export function assignCounts(base: StandbyPlan, counts: ReadonlyMap<string, number>): StandbyPlan {
  const left = new Map(counts);
  const result = new Map<string, string | null>();
  for (const a of base.assignments) {
    const room = a.site_id ? (left.get(a.site_id) ?? 0) : 0;
    if (a.site_id && room > 0) {
      result.set(a.vehicle_id, a.site_id);
      left.set(a.site_id, room - 1);
    }
  }
  const free = base.assignments.filter((a) => !result.has(a.vehicle_id));
  const homeFirst = [...free.filter((a) => a.site_id === null), ...free.filter((a) => a.site_id)];
  for (const [site, n] of [...left].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = 0; i < n; i++) {
      const a = homeFirst.shift();
      if (!a) break;
      result.set(a.vehicle_id, site);
    }
  }
  return makePlan(
    base.assignments.map((a) => ({
      vehicle_id: a.vehicle_id,
      site_id: result.get(a.vehicle_id) ?? null,
    })),
  );
}

/** "3 at Harbour container terminal (lh-01, lh-02, lh-05), …": which trucks matter, not only how
 * many, because trucks start from different places. Trucks at the depot are counted only. */
function countsLabel(net: NetworkConfig, plan: StandbyPlan): string {
  const bySite = new Map<string, string[]>();
  for (const a of plan.assignments)
    bySite.set(a.site_id ?? "home", [...(bySite.get(a.site_id ?? "home") ?? []), a.vehicle_id]);
  const parts = net.sites
    .filter((s) => bySite.has(s.id))
    .map((s) => {
      const ids = bySite.get(s.id) as string[];
      return `${ids.length} at ${s.name} (${ids.join(", ")})`;
    });
  const home = bySite.get("home")?.length ?? 0;
  if (home) parts.push(`${home} at the depot`);
  return parts.join(", ") || "no trucks";
}

interface Seed {
  readonly plan: StandbyPlan;
  readonly origin: CandidateOrigin;
  readonly label?: string;
}

function initialCandidates(
  net: NetworkConfig,
  demand: readonly SiteDemand[],
  base: StandbyPlan,
): Seed[] {
  const fleet = base.assignments.length;
  const totalCap = standbySites(net).reduce((n, s) => n + standbyCapacity(net, s.id), 0);
  const sizes = [
    ...new Set([
      Math.ceil(fleet / 3),
      Math.ceil(fleet / 2),
      Math.ceil((2 * fleet) / 3),
      Math.min(fleet, totalCap),
    ]),
  ].filter((k) => k >= 1);
  const seeds: Seed[] = sizes.map((k) => ({
    plan: assignCounts(base, proportionalCounts(net, demand, k)),
    origin: "proportional",
  }));
  const busiest = [...demand]
    .filter((d) => d.standby_capacity > 0 && d.transfers_per_hour > 0)
    .sort(
      (a, b) => b.transfers_per_hour - a.transfers_per_hour || a.site_id.localeCompare(b.site_id),
    )[0];
  if (busiest)
    seeds.push({
      plan: assignCounts(
        base,
        new Map([[busiest.site_id, Math.min(fleet, busiest.standby_capacity)]]),
      ),
      origin: "busiest_origin",
    });
  return seeds;
}

/** Plans one truck away from `plan`: move a truck between two places (sites or home). */
function neighbours(
  net: NetworkConfig,
  demand: readonly SiteDemand[],
  plan: StandbyPlan,
): StandbyPlan[] {
  const counts = planCounts(plan);
  const places = [...standbySites(net).map((s) => s.id), null];
  const rate = (site: string | null) =>
    site === null ? 0 : (demand.find((d) => d.site_id === site)?.transfers_per_hour ?? 0);
  const moves: { plan: StandbyPlan; gain: number; key: string }[] = [];
  for (const from of places) {
    const truck = plan.assignments.find((a) => a.site_id === from);
    if (!truck) continue;
    for (const to of places) {
      if (to === from) continue;
      if (to !== null && (counts[to] ?? 0) >= standbyCapacity(net, to)) continue;
      const next = makePlan(
        plan.assignments.map((a) =>
          a.vehicle_id === truck.vehicle_id ? { ...a, site_id: to } : a,
        ),
      );
      // Order moves by the demand they serve per truck (largest first), then by name.
      const gain =
        rate(to) / ((to ? (counts[to] ?? 0) : 0) + 1) -
        rate(from) / Math.max(1, from ? (counts[from] ?? 1) : 1);
      moves.push({ plan: next, gain, key: `${from ?? "home"}>${to ?? "home"}` });
    }
  }
  return moves.sort((a, b) => b.gain - a.gain || a.key.localeCompare(b.key)).map((m) => m.plan);
}

// ---------------------------------------------------------------------------------------------
// Evaluation

function simulationConstraints(
  t: Trajectory,
  baseline: FleetMetrics,
  o: OptimizeOptions,
): ConstraintResult[] {
  const floor = Math.ceil((baseline.pallets_delivered * o.service_floor_pct) / 100);
  return [
    {
      id: "commands_accepted",
      label: "The engine accepts every standby command",
      stage: "simulation",
      satisfied: t.rejections.length === 0,
      detail: t.rejections.length
        ? t.rejections.map((r) => `${r.code}: ${r.message}`).join("; ")
        : "all accepted",
    },
    {
      id: "engine_invariants",
      label: "Engine invariants hold for the whole horizon",
      stage: "simulation",
      satisfied: t.violations.length === 0,
      detail: t.violations.length ? t.violations.slice(0, 3).join("; ") : "no violation",
    },
    {
      id: "service_level",
      label: `Delivers at least ${o.service_floor_pct} % of the baseline's pallets`,
      stage: "simulation",
      satisfied: t.metrics.pallets_delivered >= floor,
      detail: `${t.metrics.pallets_delivered} pallets delivered, floor ${floor}`,
    },
    {
      id: "no_extra_cancellations",
      label: "No more cancelled transfers than the baseline",
      stage: "simulation",
      satisfied: t.metrics.transfers_cancelled <= baseline.transfers_cancelled,
      detail: `${t.metrics.transfers_cancelled} cancelled, baseline ${baseline.transfers_cancelled}`,
    },
  ];
}

/** Lower primary objective first; plans with no value last. */
const objective = (m: FleetMetrics | null) => m?.[PRIMARY_METRIC] ?? Number.POSITIVE_INFINITY;

function improvement(baseline: FleetMetrics, m: FleetMetrics, o: OptimizeOptions) {
  const b = baseline[PRIMARY_METRIC];
  const c = m[PRIMARY_METRIC];
  if (b === null || c === null) return { enough: false, s: 0, pct: 0 };
  const s = round(b - c, 1);
  const pct = b > 0 ? round((s / b) * 100, 1) : 0;
  return { enough: s >= o.min_improvement_s && pct >= o.min_improvement_pct && s > 0, s, pct };
}

async function run(
  snapshot: Snapshot,
  kind: Evaluation["kind"],
  seedsOrSearch: { seeds: Seed[]; search: boolean },
  partial: Partial<OptimizeOptions>,
  hooks: EvaluateHooks,
): Promise<Evaluation> {
  const o = checkOptions(partial);
  hooks.onProgress?.({
    stage: "validating",
    simulations_done: 0,
    simulations_running: 0,
    simulations_budget: o.max_evaluations,
    label: "Validating the snapshot",
    fraction: 0,
  });
  const { config, state } = checkSnapshot(snapshot);
  const net = config.network as NetworkConfig;
  const executor = hooks.executor ?? inlineExecutor;
  const now = hooks.now ?? (() => 0);
  const started = now();
  const timeout = AbortSignal.timeout(TIME_LIMIT_MS);
  const signal = hooks.signal ? AbortSignal.any([hooks.signal, timeout]) : timeout;
  const base = currentPlan(state);
  const demand = siteDemand(config, state);
  const source = sourceRef(config, state);
  let simulations = 0;
  let ticks = 0;
  const budget = o.max_evaluations;

  // Progress: simulations whose results were used, plus the share done of those running now.
  const partialTicks = new Map<number, number>();
  const progress = (stage: Progress["stage"], label: string) => {
    let within = 0;
    for (const t of partialTicks.values()) within += t / o.horizon_ticks;
    hooks.onProgress?.({
      stage,
      simulations_done: simulations,
      simulations_running: partialTicks.size,
      simulations_budget: budget,
      label,
      fraction: Math.min(1, (simulations + within) / budget),
    });
  };

  /** Simulate a batch of plans (in parallel when the executor can). `n`: command-id suffix. */
  const batch = async (
    plans: readonly { plan: StandbyPlan; label: string; n: number }[],
    stage: Progress["stage"],
    label: string,
  ): Promise<Trajectory[]> => {
    partialTicks.clear();
    for (const [i] of plans.entries()) partialTicks.set(i, 0);
    progress(stage, label);
    try {
      return await executor.run(
        plans.map((p) => ({ commands: planCommands(base, p.plan, `twin-${p.n}`), label: p.label })),
        {
          config,
          state,
          stateHash: snapshot.state_hash,
          horizon: o.horizon_ticks,
          signal,
          yieldEvery: hooks.yieldEvery,
          onTicks: (i, n) => {
            partialTicks.set(i, n);
            progress(stage, plans[i]?.label ?? label);
          },
        },
      );
    } catch (e) {
      if (e instanceof EvaluationAborted || signal.aborted)
        throw timeout.aborted
          ? new TwinError(
              "EVALUATION_TIMEOUT",
              `The evaluation took longer than ${TIME_LIMIT_MS / 1000} s and was stopped.`,
            )
          : new TwinError("CANCELLED", "The evaluation was cancelled.");
      throw e;
    } finally {
      partialTicks.clear();
    }
  };

  type Entry = {
    seed: Seed;
    id: string;
    constraints: ConstraintResult[];
    trajectory: Trajectory | null;
  };
  const seen = new Set<string>([hashValue(base)]);
  const scored: Entry[] = [];
  let considered = 1;
  const labelOf = (seed: Seed) => seed.label ?? countsLabel(net, seed.plan);

  // Phase 1: the baseline and the initial candidates, decided without any result, run together.
  // The bookkeeping (ids, duplicates, budget) is exactly that of evaluating them one by one.
  let planned = 1;
  const firstJobs: Entry[] = [];
  for (const seed of seedsOrSearch.seeds) {
    if (planned >= budget) break;
    const key = hashValue(seed.plan);
    considered += 1;
    // Operators' own plans are always shown, even one equal to the baseline or to another.
    if (seen.has(key) && seed.origin !== "user") continue;
    seen.add(key);
    const entry: Entry = {
      seed,
      id: `c${scored.length + 1}`,
      constraints: validatePlan(config, state, seed.plan),
      trajectory: null,
    };
    scored.push(entry);
    if (entry.constraints.some((c) => !c.satisfied)) continue;
    firstJobs.push(entry);
    planned += 1;
  }
  const first = await batch(
    [
      { plan: base, label: "Baseline: the standby plan in effect", n: 0 },
      ...firstJobs.map((e) => ({
        plan: e.seed.plan,
        label: labelOf(e.seed),
        n: Number(e.id.slice(1)),
      })),
    ],
    "simulating",
    `Baseline and ${firstJobs.length} candidate plan${firstJobs.length === 1 ? "" : "s"}`,
  );
  const baseT = first[0] as Trajectory;
  for (const [i, e] of firstJobs.entries()) {
    const t = first[i + 1] as Trajectory;
    e.trajectory = t;
    e.constraints = [...e.constraints, ...simulationConstraints(t, baseT.metrics, o)];
  }
  simulations = planned;
  ticks = planned * o.horizon_ticks;

  const feasible = (s: Entry) => s.trajectory !== null && s.constraints.every((c) => c.satisfied);
  const objectiveOf = (s: Entry) => objective(s.trajectory?.metrics ?? null);

  if (seedsOrSearch.search) {
    // Phase 2: first-improvement hill climbing from the best feasible plan so far. Neighbours
    // are simulated in windows of up to `parallelism` plans, then taken in order exactly as a
    // one-by-one search would: results after the first improvement are discarded unused.
    let best = scored.filter(feasible).sort((a, b) => objectiveOf(a) - objectiveOf(b))[0];
    let improved = true;
    while (best && improved && simulations < budget) {
      improved = false;
      const list = neighbours(net, demand, best.seed.plan);
      let i = 0;
      while (i < list.length && !improved) {
        if (simulations >= budget) break;
        const room = Math.min(executor.parallelism, budget - simulations);
        type Item =
          | { kind: "dup"; plan: StandbyPlan; key: string }
          | {
              kind: "invalid" | "sim";
              plan: StandbyPlan;
              key: string;
              constraints: ConstraintResult[];
            };
        const window: Item[] = [];
        const keys = new Set<string>();
        let sims = 0;
        for (let j = i; j < list.length && sims < room; j++) {
          const plan = list[j] as StandbyPlan;
          const key = hashValue(plan);
          if (seen.has(key) || keys.has(key)) {
            window.push({ kind: "dup", plan, key });
            continue;
          }
          keys.add(key);
          const constraints = validatePlan(config, state, plan);
          const ok = constraints.every((c) => c.satisfied);
          window.push({ kind: ok ? "sim" : "invalid", plan, key, constraints });
          if (ok) sims += 1;
        }
        // Command-id suffixes as a one-by-one search would number them.
        let pushes = scored.length;
        const toRun: { plan: StandbyPlan; label: string; n: number; item: Item }[] = [];
        for (const item of window) {
          if (item.kind === "dup") continue;
          pushes += 1;
          if (item.kind === "sim")
            toRun.push({ plan: item.plan, label: countsLabel(net, item.plan), n: pushes, item });
        }
        const results = toRun.length
          ? await batch(toRun, "searching", "Local search: single-truck moves")
          : [];
        const resultOf = new Map(toRun.map((r, k) => [r.item, results[k] as Trajectory]));
        for (const item of window) {
          if (simulations >= budget) break;
          i += 1;
          considered += 1;
          if (item.kind === "dup") continue;
          seen.add(item.key);
          const entry: Entry = {
            seed: { plan: item.plan, origin: "local_search" },
            id: `c${scored.length + 1}`,
            constraints: item.constraints,
            trajectory: null,
          };
          scored.push(entry);
          if (item.kind === "invalid") continue;
          const t = resultOf.get(item) as Trajectory;
          entry.trajectory = t;
          entry.constraints = [...item.constraints, ...simulationConstraints(t, baseT.metrics, o)];
          simulations += 1;
          ticks += o.horizon_ticks;
          if (feasible(entry) && objectiveOf(entry) < objectiveOf(best)) {
            best = entry;
            improved = true;
            break;
          }
        }
      }
    }
  }
  progress("ranking", "Checking constraints and ranking plans");

  // Rank, choose and explain.
  const ranked = scored
    .filter(feasible)
    .sort(
      (a, b) =>
        objective(a.trajectory?.metrics ?? null) - objective(b.trajectory?.metrics ?? null) ||
        planChanges(base, a.seed.plan).length - planChanges(base, b.seed.plan).length ||
        a.id.localeCompare(b.id),
    );
  const winner =
    ranked.find(
      (s) => improvement(baseT.metrics, (s.trajectory as Trajectory).metrics, o).enough,
    ) ?? null;

  const candidates: CandidateResult[] = scored.map((s) => {
    const metrics = s.trajectory?.metrics ?? null;
    const ok = feasible(s);
    const imp = metrics ? improvement(baseT.metrics, metrics, o) : null;
    const verdict: Verdict = !ok
      ? "infeasible"
      : s === winner
        ? "recommended"
        : imp?.enough
          ? "improves"
          : "no_better";
    const reasons: string[] = [];
    for (const c of s.constraints) if (!c.satisfied) reasons.push(`${c.label}: ${c.detail}.`);
    if (ok && imp) {
      if (imp.s <= 0)
        reasons.push(`Mean pickup wait is not lower than the baseline's (${fmtSigned(-imp.s)} s).`);
      else if (!imp.enough)
        reasons.push(
          `Mean pickup wait falls by ${imp.s} s (${imp.pct} %), below the ${o.min_improvement_pct} % / ${o.min_improvement_s} s threshold.`,
        );
      else reasons.push(`Mean pickup wait falls by ${imp.s} s (${imp.pct} %).`);
    }
    if (!s.trajectory && ok === false && s.constraints.every((c) => c.stage === "plan"))
      reasons.push("Not simulated: the plan breaks a hard rule.");
    return {
      candidate_id: s.id,
      label: s.seed.label ?? countsLabel(net, s.seed.plan),
      origin: s.seed.origin,
      plan: s.seed.plan,
      changes: planChanges(base, s.seed.plan),
      constraints: s.constraints,
      feasible: ok,
      metrics,
      deltas: metrics ? compareMetrics(baseT.metrics, metrics) : [],
      verdict,
      rank: ok ? ranked.indexOf(s) + 1 : null,
      reasons,
      end_state_hash: s.trajectory?.end_state_hash ?? null,
    };
  });

  const minutes = round((o.horizon_ticks * config.tick_ms) / 60_000, 1);
  let recommendation: Recommendation | null = null;
  let noReason: string | null = null;
  if (winner) {
    const c = candidates.find((x) => x.candidate_id === winner.id) as CandidateResult;
    recommendation = explain(net, demand, c, baseT.metrics, ranked.length, minutes, candidates);
  } else if (baseT.metrics.transfers_planned === 0) {
    noReason = `No transfer is planned in the next ${minutes} simulated minutes, so where trucks wait makes no difference.`;
  } else if (ranked.length === 0) {
    noReason = "No candidate plan met every hard constraint.";
  } else {
    const best = candidates.find((x) => x.candidate_id === ranked[0]?.id);
    noReason = `No plan beat the current one by at least ${o.min_improvement_pct} % and ${o.min_improvement_s} s of mean pickup wait. Best evaluated: ${best?.label} (${best?.reasons.at(-1) ?? ""})`;
  }

  progress("done", "Done");
  const evaluated = {
    kind,
    strategy: STANDBY_STRATEGY,
    source,
    options: o,
    plans: scored.map((s) => hashValue(s.seed.plan)),
  };
  return {
    evaluation_id: deterministicUuid(`twin:${hashValue(evaluated)}`, 0),
    kind,
    strategy: STANDBY_STRATEGY,
    source,
    options: o,
    objective: { metric: PRIMARY_METRIC, direction: "minimize" },
    demand,
    baseline: {
      plan: base,
      metrics: baseT.metrics,
      constraints: simulationConstraints(baseT, baseT.metrics, o).filter(
        (c) => c.id === "engine_invariants",
      ),
      end_state_hash: baseT.end_state_hash,
    },
    candidates,
    recommendation,
    no_recommendation_reason: noReason,
    assumptions: assumptions(minutes, o),
    risks: risks(baseT.metrics, candidates, recommendation),
    search: {
      simulations,
      budget,
      plans_considered: considered,
      exhausted_budget: simulations >= budget,
    },
    runtime: { elapsed_ms: Math.round(now() - started), ticks_simulated: ticks },
  };
}

const fmtSigned = (x: number) => (x > 0 ? `+${x}` : `${x}`);

function explain(
  net: NetworkConfig,
  demand: readonly SiteDemand[],
  c: CandidateResult,
  baseline: FleetMetrics,
  feasibleCount: number,
  minutes: number,
  all: readonly CandidateResult[],
): Recommendation {
  const d = (k: keyof FleetMetrics) => c.deltas.find((x) => x.key === k) as MetricDelta;
  const wait = d("pickup_wait_s");
  const empty = d("empty_km");
  const pallets = d("pallets_delivered");
  const counts = planCounts(c.plan);
  const reasons: string[] = [];
  for (const site of net.sites) {
    const n = counts[site.id];
    if (!n) continue;
    const rate = demand.find((x) => x.site_id === site.id)?.transfers_per_hour ?? 0;
    reasons.push(
      `${n} truck${n > 1 ? "s" : ""} wait${n > 1 ? "" : "s"} at ${site.name}, which sends ${rate} transfers per hour; a waiting truck starts loading there without first driving from the depot.`,
    );
  }
  reasons.push(
    `Simulated over the next ${minutes} minutes from the same state: mean pickup wait ${wait.baseline} s → ${wait.candidate} s (${wait.pct} %).`,
  );
  reasons.push(
    `Empty driving ${empty.baseline} km → ${empty.candidate} km (${empty.pct === null ? "n/a" : `${fmtSigned(empty.pct)} %`}); pallets delivered ${pallets.baseline} → ${pallets.candidate}.`,
  );
  const runnerUp = all.find((x) => x.rank === 2);
  reasons.push(
    `Best of ${feasibleCount} feasible plan${feasibleCount > 1 ? "s" : ""} simulated${runnerUp ? `; next best: ${runnerUp.label}` : ""}.`,
  );
  if (baseline.transfers_planned !== c.metrics?.transfers_planned)
    reasons.push(
      `The workload differs slightly between the two runs (${baseline.transfers_planned} vs ${c.metrics?.transfers_planned} transfers planned): lanes draw their quantities at random as stock changes.`,
    );
  return {
    candidate_id: c.candidate_id,
    summary: `Stand by ${c.label} (${c.changes.length} truck${c.changes.length === 1 ? "" : "s"} change${c.changes.length === 1 ? "s" : ""}): mean pickup wait ${wait.pct} % over the next ${minutes} simulated minutes.`,
    reasons,
  };
}

function assumptions(minutes: number, o: OptimizeOptions): string[] {
  return [
    `The network runs as configured for the next ${minutes} simulated minutes: lanes keep their schedules, and no operator transfers or other commands are added.`,
    "Baseline and candidates start from the same frozen snapshot and are run by the simulation engine itself; the plan is applied with the same linehaul.set_standby commands that approval would submit.",
    `Each plan is one deterministic trajectory. A plan is recommended only if it beats the baseline by at least ${o.min_improvement_pct} % and ${o.min_improvement_s} s, to stay clear of run-to-run noise.`,
    "Standby trucks occupy staging stalls; the engine always keeps one stall per site free for arriving trucks.",
    "The search is heuristic (demand-proportional plans and single-truck moves within a fixed budget): the recommendation is the best plan evaluated, not a proven optimum.",
  ];
}

function risks(
  baseline: FleetMetrics,
  candidates: readonly CandidateResult[],
  rec: Recommendation | null,
): string[] {
  const out = [
    "Predictions, not measurements: the figures are simulated forward from the snapshot and will differ from what happens if conditions change.",
    "Waits still open at the end of the horizon are counted until the end, so long waits are under-stated equally for every plan.",
  ];
  const chosen = candidates.find((c) => c.candidate_id === rec?.candidate_id);
  const empty = chosen?.deltas.find((d) => d.key === "empty_km");
  if (empty?.improved === false && (empty.abs ?? 0) > 0)
    out.push(
      `Empty driving rises by ${empty.abs} km: trucks drive to their standby stalls, so faster pickups cost some extra kilometres.`,
    );
  if (baseline.transfers_planned < 10)
    out.push(
      `Only ${baseline.transfers_planned} transfers fall in the horizon: few samples make the comparison uncertain; a longer horizon helps.`,
    );
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public entry points

/** Optimise where idle trucks wait, from a frozen snapshot of the live run. */
export async function optimizeStandby(
  snapshot: Snapshot,
  options: Partial<OptimizeOptions> = {},
  hooks: EvaluateHooks = {},
): Promise<Evaluation> {
  const { config, state } = checkSnapshot(snapshot);
  const net = config.network as NetworkConfig;
  const seeds = initialCandidates(net, siteDemand(config, state), currentPlan(state));
  return run(snapshot, "optimization", { seeds, search: true }, options, hooks);
}

/** What-if: compare the plan in effect with the operator's own alternatives (no search). */
export async function compareStandbyPlans(
  snapshot: Snapshot,
  alternatives: readonly { readonly label?: string; readonly plan: StandbyPlan }[],
  options: Partial<OptimizeOptions> = {},
  hooks: EvaluateHooks = {},
): Promise<Evaluation> {
  const o = checkOptions(options);
  if (alternatives.length === 0)
    throw new TwinError("INVALID_PLAN", "Give at least one alternative plan to compare.");
  if (alternatives.length > o.max_evaluations - 1)
    throw new TwinError(
      "INVALID_PLAN",
      `At most ${o.max_evaluations - 1} alternatives can be compared at once.`,
    );
  const seeds = alternatives.map((a) => ({
    plan: makePlan(a.plan.assignments),
    origin: "user" as const,
    label: a.label,
  }));
  return run(snapshot, "what_if", { seeds, search: false }, o, hooks);
}
