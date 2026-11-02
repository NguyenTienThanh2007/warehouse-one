/**
 * Multi-seed robustness evaluation (Phase 6.2, DEC-043): does a plan the optimiser found keep
 * beating the plan in effect when the future plays out differently?
 *
 * The optimiser (discovery) simulates every plan on one future: the live run's own random stream,
 * as captured in the snapshot. Here the baseline and one chosen candidate are simulated again on
 * `n` other futures. Each future ("seed") is a copy of the same snapshot whose random-number
 * state is replaced by `seedRng("twin-robustness:<root>:<i>")`, the engine's own seeding
 * function: same trucks, stock, transfers and clock, different random draws from then on. For
 * every seed both plans start from that identical state (a paired observation), and the paired
 * differences are summarised with a 95 % Student t interval (stats.ts).
 *
 * What this is and is not:
 * - Validation seeds never include the discovery future (checked), so the candidate was not
 *   selected on the futures it is judged on. It was still selected by the optimiser among others,
 *   on one future: this evaluates that one candidate, it does not re-optimise across seeds.
 * - Pairing is exact at the start only. The engine has one random stream and some draws depend on
 *   the state (a lane draws only while it has room for more open transfers), so once the plans
 *   diverge they can see different demand. `workload` reports on how many seeds that happened.
 * - Every seed is a different future from the same present, not a different present.
 */
import {
  deterministicUuid,
  hashValue,
  seedRng,
  stateHash,
  type RngState,
  type SimulationState,
  type Snapshot,
} from "@warehouse-one/simulation";
import { sourceRef, type SourceRef } from "./context";
import { inlineExecutor, type TrajectoryExecutor } from "./executor";
import {
  EvaluationAborted,
  METRICS,
  PRIMARY_METRIC,
  type FleetMetrics,
  type MetricInfo,
  type MetricKey,
  type Trajectory,
} from "./metrics";
import {
  checkSnapshot,
  simulationConstraints,
  STANDBY_STRATEGY,
  TwinError,
  type Evaluation,
  type OptimizeOptions,
} from "./optimizer";
import {
  currentPlan,
  planCommands,
  validatePlan,
  type ConstraintResult,
  type StandbyPlan,
} from "./plan";
import {
  evidenceOf,
  MIN_PAIRS_FOR_VERDICT,
  pairedStats,
  roundForDisplay,
  type PairedStats,
  type PairedSummary,
} from "./stats";

export const ROBUSTNESS_METHOD = {
  id: "paired-t-95",
  version: "1.0.0",
  description:
    "Paired observations per seed (same start state for both plans); 95 % Student t interval of the mean paired difference; verdict on mean pickup wait.",
} as const;

/**
 * Bounded: two simulations per seed, and the t table covers up to 30 pairs. Fewer than five seeds
 * run (benchmarks, quick checks) but always give "insufficient_data".
 */
export const SEED_LIMITS = { min: 1, max: 30 } as const;

/** Offered seed counts. Costs measured in docs/phases/PHASE_6.md §8. */
export const SEED_TIERS = [
  { id: "quick", seeds: 5, label: "Quick" },
  { id: "standard", seeds: 20, label: "Standard" },
  { id: "extended", seeds: 30, label: "Extended" },
] as const;

/** Seeds simulated per executor batch: 2 jobs each, 16 jobs, the worker pool's per-request cap. */
export const SEEDS_PER_BATCH = 8;

/** Wall-clock limit of one robustness evaluation (30 seeds × 60 min on the main thread fits). */
export const ROBUSTNESS_TIME_LIMIT_MS = 600_000;

export type RobustnessVerdict =
  | "improved"
  | "improved_below_threshold"
  | "inconclusive"
  | "regressed"
  | "constraint_failure"
  | "insufficient_data";

export interface RobustnessOptions {
  readonly seeds: number;
  /** Seeds are derived from it; default: from the snapshot's hash, so reruns reproduce. */
  readonly root_seed: string;
}

export interface SeedRun {
  readonly metrics: FleetMetrics;
  readonly end_state_hash: string;
  readonly violations: number;
  readonly rejections: number;
}

export interface SeedResult {
  /** 1-based position; results are always in this order. */
  readonly index: number;
  /** The string given to `seedRng`. */
  readonly seed: string;
  /** Hash of the seeded start state both plans ran from. */
  readonly start_state_hash: string;
  readonly baseline: SeedRun;
  readonly candidate: SeedRun;
  /** candidate − baseline per metric (null when either side has no value). */
  readonly deltas: Readonly<Record<MetricKey, number | null>>;
  /** Hard constraints of the candidate on this seed (and the baseline's engine invariants). */
  readonly constraints: readonly ConstraintResult[];
  readonly passed: boolean;
  /** The plans saw different demand on this seed (transfers or pallets planned differ). */
  readonly workload_diverged: boolean;
}

export interface MetricSummary extends PairedSummary {
  readonly key: MetricKey;
  readonly label: string;
  readonly unit: MetricInfo["unit"];
  readonly better: MetricInfo["better"];
}

export interface RobustnessEvaluation {
  readonly robustness_id: string;
  readonly method: typeof ROBUSTNESS_METHOD;
  readonly strategy: typeof STANDBY_STRATEGY;
  /** The single-seed evaluation (discovery) the candidate comes from. */
  readonly discovery: {
    readonly evaluation_id: string;
    readonly kind: Evaluation["kind"];
    /** Hash of the live random-number state discovery used; no validation seed equals it. */
    readonly rng_hash: string;
  };
  readonly source: SourceRef;
  readonly candidate: {
    readonly candidate_id: string;
    readonly label: string;
    readonly plan: StandbyPlan;
  };
  readonly baseline_plan: StandbyPlan;
  readonly options: RobustnessOptions & {
    readonly horizon_ticks: number;
    readonly min_improvement_pct: number;
    readonly min_improvement_s: number;
    readonly service_floor_pct: number;
  };
  readonly seeds: {
    readonly root_seed: string;
    readonly count: number;
    readonly derivation: string;
  };
  readonly per_seed: readonly SeedResult[];
  readonly primary: MetricKey;
  readonly metrics: readonly MetricSummary[];
  readonly verdict: RobustnessVerdict;
  readonly reasons: readonly string[];
  /** Other metrics that are reliably worse with the candidate (shown, never folded into a score). */
  readonly tradeoffs: readonly string[];
  readonly workload: { readonly diverged_seeds: number; readonly note: string };
  readonly limitations: readonly string[];
  /** Wall-clock facts; not part of the deterministic result. */
  readonly runtime: { readonly elapsed_ms: number; readonly ticks_simulated: number };
}

export interface RobustnessProgress {
  readonly stage: "validating" | "simulating" | "aggregating" | "done";
  readonly seeds_total: number;
  readonly seeds_done: number;
  readonly seeds_running: number;
  readonly label: string;
  /** 0..1 over the whole evaluation. */
  readonly fraction: number;
}

export interface RobustnessHooks {
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: RobustnessProgress) => void;
  readonly yieldEvery?: number;
  readonly now?: () => number;
  readonly executor?: TrajectoryExecutor;
}

const ROOT_SEED = /^[A-Za-z0-9_-]{1,40}$/;

/** The string seeding validation future `index` (1-based). */
export const seedString = (root: string, index: number): string =>
  `twin-robustness:${root}:${index}`;

export const defaultRootSeed = (snapshot: Snapshot): string => snapshot.state_hash.slice(0, 12);

export function checkRobustnessOptions(
  snapshot: Snapshot,
  partial: Partial<RobustnessOptions> = {},
): RobustnessOptions {
  const o = { seeds: 20, root_seed: defaultRootSeed(snapshot), ...partial };
  const problems: string[] = [];
  if (!Number.isInteger(o.seeds) || o.seeds < SEED_LIMITS.min || o.seeds > SEED_LIMITS.max)
    problems.push(`seeds must be an integer within [${SEED_LIMITS.min}, ${SEED_LIMITS.max}]`);
  if (!ROOT_SEED.test(o.root_seed))
    problems.push("root_seed must be 1–40 letters, digits, '-' or '_'");
  if (problems.length) throw new TwinError("INVALID_OPTIONS", problems.join("; "));
  return o;
}

/** The seeded start states, in order; refuses duplicates and the discovery stream itself. */
export function seededStarts(
  state: SimulationState,
  root: string,
  count: number,
): { seed: string; rng: RngState }[] {
  const seen = new Set<string>([state.rng.join(",")]);
  const out: { seed: string; rng: RngState }[] = [];
  for (let i = 1; i <= count; i++) {
    const seed = seedString(root, i);
    const rng = seedRng(seed);
    const key = rng.join(",");
    if (seen.has(key))
      throw new TwinError(
        "INVALID_OPTIONS",
        `Seed ${seed} repeats a random state already in use; choose another root seed.`,
      );
    seen.add(key);
    out.push({ seed, rng });
  }
  return out;
}

/** "−5.2", "+0.4": signed, with a true minus sign, for reasons shown to the operator. */
const signed = (x: number, digits = 1): string =>
  `${x < 0 ? "−" : x > 0 ? "+" : "±"}${Math.abs(x).toFixed(digits)}`;

/**
 * `x` with one decimal, or more when one decimal would put it on the other side of `limit` than
 * it is (1.9996 s against 2 s reads "1.9996", not "2.0"): text never contradicts the decision.
 */
const against = (x: number, limit: number): string => {
  for (let digits = 1; digits <= 6; digits++) {
    const shown = x.toFixed(digits);
    if (Number(shown) >= limit === x >= limit) return shown;
  }
  return String(x);
};

const deltaOf = (b: number | null, c: number | null): number | null =>
  b === null || c === null ? null : c - b;

/** A seed on which the candidate broke a hard constraint. */
export interface SeedFailure {
  readonly index: number;
  /** "label: detail" of each failed constraint. */
  readonly failed: readonly string[];
  readonly workload_diverged: boolean;
}

/**
 * The verdict on the primary metric, with its reasons. Pure; documented in DEC-043. `primary` must
 * be the unrounded statistics (`pairedStats`), never the display summary: every comparison with
 * zero and with the thresholds is made on exact values, and the direction comes from
 * `evidenceOf`, so the verdict always agrees with the primary metric's evidence.
 */
export function robustnessVerdict(
  primary: PairedStats,
  failures: readonly SeedFailure[],
  o: { readonly min_improvement_pct: number; readonly min_improvement_s: number },
): { verdict: RobustnessVerdict; reasons: string[] } {
  if (failures.length > 0) {
    // The statistical reading is still reported, as context; it never overrides the failure.
    const reading = robustnessVerdict(primary, [], o);
    return {
      verdict: "constraint_failure",
      reasons: [
        `A hard constraint failed on ${failures.length} seed${failures.length === 1 ? "" : "s"} (${failures.map((f) => f.index).join(", ")}). Hard constraints must hold on every seed, whatever the averages say.`,
        ...failures
          .slice(0, 5)
          .map(
            (f) =>
              `Seed ${f.index}: ${f.failed.join("; ")}${f.workload_diverged ? " (the plans saw different demand on this seed)" : ""}.`,
          ),
        `Mean pickup wait alone, not the verdict, would read "${reading.verdict.replaceAll("_", " ")}": ${reading.reasons[0] ?? ""}`,
      ],
    };
  }
  if (primary.n < MIN_PAIRS_FOR_VERDICT || primary.ci95 === null || primary.mean_diff === null)
    return {
      verdict: "insufficient_data",
      reasons: [
        `Only ${primary.n} seed${primary.n === 1 ? "" : "s"} had a mean pickup wait for both plans${primary.missing ? ` (${primary.missing} without one)` : ""}; at least ${MIN_PAIRS_FOR_VERDICT} are needed for a verdict.`,
      ],
    };
  const ci = `95 % interval of the change in mean pickup wait: ${signed(primary.ci95.low)} s to ${signed(primary.ci95.high)} s`;
  if (primary.degenerate)
    return {
      verdict: "inconclusive",
      reasons: [
        `Every one of the ${primary.n} seeds gave the same change in mean pickup wait (${signed(primary.mean_diff)} s): the interval has zero width and is not a statistical estimate, so it is no evidence either way.`,
        `Seeds better / worse / tied: ${primary.seeds_better} / ${primary.seeds_worse} / ${primary.seeds_tied}.`,
      ],
    };
  const evidence = evidenceOf(primary.ci95, "lower", primary.n, primary.degenerate);
  if (evidence === "better") {
    const s = -primary.mean_diff;
    const pct = primary.relative_pct === null ? null : -primary.relative_pct;
    const practical = s >= o.min_improvement_s && pct !== null && pct >= o.min_improvement_pct;
    const amount = `${against(s, o.min_improvement_s)} s (${pct === null ? "no baseline to compare" : `${against(pct, o.min_improvement_pct)} %`})`;
    return practical
      ? {
          verdict: "improved",
          reasons: [
            `${ci}, entirely below zero, over ${primary.n} seeds.`,
            `Mean reduction ${amount}, at least the ${o.min_improvement_pct} % / ${o.min_improvement_s} s practical threshold.`,
          ],
        }
      : {
          verdict: "improved_below_threshold",
          reasons: [
            `${ci}, entirely below zero, over ${primary.n} seeds: the candidate is reliably better.`,
            `But the mean reduction, ${amount}, is below the ${o.min_improvement_pct} % / ${o.min_improvement_s} s practical threshold.`,
          ],
        };
  }
  if (evidence === "worse")
    return {
      verdict: "regressed",
      reasons: [`${ci}, entirely above zero: the candidate is reliably worse.`],
    };
  return {
    verdict: "inconclusive",
    reasons: [
      `${ci}, which includes zero: these ${primary.n} seeds cannot tell the plans apart.`,
      `Seeds better / worse / tied: ${primary.seeds_better} / ${primary.seeds_worse} / ${primary.seeds_tied}.`,
    ],
  };
}

/**
 * Evaluate one candidate of a single-seed evaluation against its baseline on `seeds` other
 * futures of the same snapshot. Results never depend on the executor or the order in which jobs
 * finish; a cancelled or failed evaluation throws and produces no verdict.
 */
export async function evaluateRobustness(
  snapshot: Snapshot,
  discovery: Evaluation,
  candidateId: string,
  partial: Partial<RobustnessOptions> = {},
  hooks: RobustnessHooks = {},
): Promise<RobustnessEvaluation> {
  const o = checkRobustnessOptions(snapshot, partial);
  const total = o.seeds;
  hooks.onProgress?.({
    stage: "validating",
    seeds_total: total,
    seeds_done: 0,
    seeds_running: 0,
    label: "Validating the snapshot and the plans",
    fraction: 0,
  });
  const { config, state } = checkSnapshot(snapshot);
  if (discovery.source.state_hash !== snapshot.state_hash)
    throw new TwinError(
      "INVALID_SNAPSHOT",
      "This snapshot is not the one the evaluation started from.",
    );
  const candidate = discovery.candidates.find((c) => c.candidate_id === candidateId);
  if (!candidate)
    throw new TwinError("INVALID_PLAN", `The evaluation has no candidate ${candidateId}.`);
  const base = currentPlan(state);
  if (hashValue(base) !== hashValue(discovery.baseline.plan))
    throw new TwinError("INVALID_PLAN", "The evaluation's baseline is not the plan in effect.");
  const planChecks = validatePlan(config, state, candidate.plan);
  if (planChecks.some((c) => !c.satisfied))
    throw new TwinError(
      "INVALID_PLAN",
      `The candidate breaks a hard rule before any simulation: ${planChecks.find((c) => !c.satisfied)?.detail}`,
    );
  const opts: OptimizeOptions = discovery.options;
  const horizon = opts.horizon_ticks;
  const starts = seededStarts(state, o.root_seed, total);

  const executor = hooks.executor ?? inlineExecutor;
  const now = hooks.now ?? (() => 0);
  const started = now();
  const timeout = AbortSignal.timeout(ROBUSTNESS_TIME_LIMIT_MS);
  const signal = hooks.signal ? AbortSignal.any([hooks.signal, timeout]) : timeout;
  const candidateCommands = planCommands(base, candidate.plan, `twin-${candidateId.slice(1)}`);
  const baselineCommands = planCommands(base, base, "twin-0");

  const perSeed: SeedResult[] = [];
  for (let first = 0; first < total; first += SEEDS_PER_BATCH) {
    const batch = starts.slice(first, first + SEEDS_PER_BATCH).map((s, k) => {
      const seeded: SimulationState = { ...state, rng: s.rng };
      return {
        index: first + k + 1,
        seed: s.seed,
        state: seeded,
        hash: stateHash(config, seeded),
      };
    });
    // Ticks of the running batch per job (2 per seed: baseline, candidate).
    const ticks = new Map<number, number>();
    const report = () => {
      let running = 0;
      let doneHere = 0;
      let within = 0;
      for (let k = 0; k < batch.length; k++) {
        const b = ticks.get(2 * k) ?? 0;
        const c = ticks.get(2 * k + 1) ?? 0;
        within += (b + c) / (2 * horizon);
        if (b >= horizon && c >= horizon) doneHere += 1;
        else if (b > 0 || c > 0) running += 1;
      }
      hooks.onProgress?.({
        stage: "simulating",
        seeds_total: total,
        seeds_done: perSeed.length + doneHere,
        seeds_running: running,
        label: `Seeds ${first + 1}–${first + batch.length} of ${total}`,
        fraction: Math.min(0.99, (perSeed.length + within) / total),
      });
    };
    report();
    let out: Trajectory[];
    try {
      out = await executor.run(
        batch.flatMap((s) => [
          {
            commands: baselineCommands,
            label: `Seed ${s.index}: baseline`,
            start: { state: s.state, stateHash: s.hash },
          },
          {
            commands: candidateCommands,
            label: `Seed ${s.index}: ${candidate.label}`,
            start: { state: s.state, stateHash: s.hash },
          },
        ]),
        {
          config,
          state,
          stateHash: snapshot.state_hash,
          horizon,
          signal,
          yieldEvery: hooks.yieldEvery,
          onTicks: (i, n) => {
            ticks.set(i, n);
            report();
          },
        },
      );
    } catch (e) {
      if (e instanceof EvaluationAborted || signal.aborted)
        throw timeout.aborted
          ? new TwinError(
              "EVALUATION_TIMEOUT",
              `The robustness evaluation took longer than ${ROBUSTNESS_TIME_LIMIT_MS / 1000} s and was stopped.`,
            )
          : new TwinError("CANCELLED", "The robustness evaluation was cancelled.");
      throw e;
    }
    for (const [k, s] of batch.entries()) {
      const bT = out[2 * k] as Trajectory;
      const cT = out[2 * k + 1] as Trajectory;
      const constraints: ConstraintResult[] = [
        ...simulationConstraints(cT, bT.metrics, opts),
        {
          id: "baseline_invariants",
          label: "Engine invariants hold for the baseline on this seed",
          stage: "simulation",
          satisfied: bT.violations.length === 0 && bT.rejections.length === 0,
          detail: bT.violations.length ? bT.violations.slice(0, 3).join("; ") : "no violation",
        },
      ];
      const deltas = Object.fromEntries(
        METRICS.map((m) => [m.key, deltaOf(bT.metrics[m.key], cT.metrics[m.key])]),
      ) as Record<MetricKey, number | null>;
      perSeed.push({
        index: s.index,
        seed: s.seed,
        start_state_hash: s.hash,
        baseline: run(bT),
        candidate: run(cT),
        deltas,
        constraints,
        passed: constraints.every((c) => c.satisfied),
        workload_diverged: deltas.transfers_planned !== 0 || deltas.pallets_planned !== 0,
      });
    }
  }

  hooks.onProgress?.({
    stage: "aggregating",
    seeds_total: total,
    seeds_done: total,
    seeds_running: 0,
    label: "Computing paired statistics",
    fraction: 0.99,
  });
  // Decisions on the unrounded statistics; the result carries them rounded for display.
  const exact = new Map<MetricKey, PairedStats>(
    METRICS.map((m) => [
      m.key,
      pairedStats(
        perSeed.map((s) => ({
          baseline: s.baseline.metrics[m.key],
          candidate: s.candidate.metrics[m.key],
        })),
        m.better,
      ),
    ]),
  );
  const metrics: MetricSummary[] = METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    unit: m.unit,
    better: m.better,
    ...roundForDisplay(exact.get(m.key) as PairedStats),
  }));
  const primary = exact.get(PRIMARY_METRIC) as PairedStats;
  const failed: SeedFailure[] = perSeed
    .filter((s) => !s.passed)
    .map((s) => ({
      index: s.index,
      failed: s.constraints.filter((c) => !c.satisfied).map((c) => `${c.label}: ${c.detail}`),
      workload_diverged: s.workload_diverged,
    }));
  const { verdict, reasons } = robustnessVerdict(primary, failed, opts);
  const tradeoffs = metrics
    .filter((m) => m.key !== PRIMARY_METRIC && m.evidence === "worse")
    .map(
      (m) =>
        `${m.label} is reliably worse: mean change ${signed(m.mean_diff ?? 0, m.unit === "km" ? 2 : 1)} ${m.unit} (95 % interval ${signed(m.ci95?.low ?? 0, m.unit === "km" ? 2 : 1)} to ${signed(m.ci95?.high ?? 0, m.unit === "km" ? 2 : 1)}).`,
    );
  const diverged = perSeed.filter((s) => s.workload_diverged).length;
  const options = {
    ...o,
    horizon_ticks: horizon,
    min_improvement_pct: opts.min_improvement_pct,
    min_improvement_s: opts.min_improvement_s,
    service_floor_pct: opts.service_floor_pct,
  };
  const identity = {
    method: ROBUSTNESS_METHOD,
    discovery: discovery.evaluation_id,
    state_hash: snapshot.state_hash,
    candidate: candidate.plan,
    options,
  };
  hooks.onProgress?.({
    stage: "done",
    seeds_total: total,
    seeds_done: total,
    seeds_running: 0,
    label: "Done",
    fraction: 1,
  });
  return {
    robustness_id: deterministicUuid(`twin-robustness:${hashValue(identity)}`, 0),
    method: ROBUSTNESS_METHOD,
    strategy: STANDBY_STRATEGY,
    discovery: {
      evaluation_id: discovery.evaluation_id,
      kind: discovery.kind,
      rng_hash: hashValue(state.rng),
    },
    source: sourceRef(config, state),
    candidate: {
      candidate_id: candidate.candidate_id,
      label: candidate.label,
      plan: candidate.plan,
    },
    baseline_plan: base,
    options,
    seeds: {
      root_seed: o.root_seed,
      count: total,
      derivation: `seedRng("${seedString(o.root_seed, 1).replace(/:1$/, ":<i>")}") for i = 1…${total}, replacing the snapshot's random-number state`,
    },
    per_seed: perSeed,
    primary: PRIMARY_METRIC,
    metrics,
    verdict,
    reasons,
    tradeoffs,
    workload: {
      diverged_seeds: diverged,
      note:
        diverged === 0
          ? "Both plans saw the same transfers and pallets planned on every seed."
          : `On ${diverged} of ${total} seeds the plans saw different demand (transfers or pallets planned differ): the engine has one random stream and some draws depend on the state, so pairing is exact only at the start.`,
    },
    limitations: [
      "The candidate was found by the optimiser on one future (the live random stream) and is evaluated here on other futures; the search itself is not repeated across seeds.",
      "Every seed starts from the same present state; this does not test other operating states.",
      "The 95 % interval assumes roughly normal paired differences; with few seeds, or heavy tails, its coverage can be lower.",
      "Only mean pickup wait decides the verdict; other metrics are reported without correction for multiple comparisons.",
      "Computed in this browser; not stored with the proposal and not re-simulated by the API.",
    ],
    runtime: {
      elapsed_ms: Math.round(now() - started),
      ticks_simulated: total * 2 * horizon,
    },
  };
}

const run = (t: Trajectory): SeedRun => ({
  metrics: t.metrics,
  end_state_hash: t.end_state_hash,
  violations: t.violations.length,
  rejections: t.rejections.length,
});
