/**
 * Optimiser benchmark (Phase 6): runs the fleet-standby strategy on the logistics park from fixed
 * start points and prints baseline vs recommendation, evaluations and wall time.
 *   pnpm bench:twin [-- --warm 6000,20000 --horizon 18000 --budget 8] [-- --components]
 * `--components` also times snapshot preparation, single trajectories per horizon and full
 * evaluations for the longer horizon and the maximum budget (all inline, one thread: the
 * reference the browser worker pool is compared with).
 * `--robustness` times multi-seed validation (Phase 6.2) of the golden fixture's recommended plan
 * for 1, 5, 10, 20 and 30 seeds, inline, and checks that a repeat gives the identical result.
 */
import {
  createInitialState,
  createNetworkScenario,
  createSnapshot,
  step,
} from "@warehouse-one/simulation";
import { readFileSync } from "node:fs";
import {
  checkSnapshot,
  currentPlan,
  evaluateRobustness,
  optimizeStandby,
  simulate,
  type Evaluation,
} from "../src/index";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const warms = arg("warm", "6000,20000").split(",").map(Number);
const horizon = Number(arg("horizon", "18000"));
const budget = Number(arg("budget", "8"));

const scenario = createNetworkScenario();
const config = scenario.config;
let state = step(config, createInitialState(config), scenario.openingCommands).state;
let at = state.tick;
console.log(`fleet-standby benchmark · horizon ${horizon} ticks · budget ${budget} simulations`);
for (const warm of warms) {
  while (at < warm) {
    state = step(config, state).state;
    at = state.tick;
  }
  const started = performance.now();
  const e = await optimizeStandby(
    createSnapshot(config, state),
    { horizon_ticks: horizon, max_evaluations: budget },
    { now: () => performance.now(), yieldEvery: 1_000_000 },
  );
  const ms = performance.now() - started;
  const rec = e.candidates.find((c) => c.candidate_id === e.recommendation?.candidate_id);
  console.log(
    `\nstart tick ${warm} · ${e.search.simulations} simulations · ${(ms / 1000).toFixed(1)} s · ${((ms / e.runtime.ticks_simulated) * 1000).toFixed(1)} µs/tick`,
  );
  console.log(
    `  baseline   wait ${e.baseline.metrics.pickup_wait_s} s · empty ${e.baseline.metrics.empty_km} km · delivered ${e.baseline.metrics.pallets_delivered} pallets · planned ${e.baseline.metrics.transfers_planned}`,
  );
  for (const c of e.candidates)
    console.log(
      `  ${c.candidate_id.padEnd(4)} ${c.verdict.padEnd(11)} ${c.origin.padEnd(14)} wait ${c.metrics?.pickup_wait_s ?? "-"} s · empty ${c.metrics?.empty_km ?? "-"} km · ${c.label}`,
    );
  console.log(
    rec
      ? `  → ${e.recommendation?.summary}`
      : `  → no recommendation: ${e.no_recommendation_reason}`,
  );
}

if (process.argv.includes("--components")) {
  let s = step(config, createInitialState(config), scenario.openingCommands).state;
  while (s.tick < 6_000) s = step(config, s).state;
  const time = async <T>(f: () => Promise<T> | T): Promise<[T, number]> => {
    const t = performance.now();
    const r = await f();
    return [r, performance.now() - t];
  };
  const prep: number[] = [];
  for (let i = 0; i < 20; i++) {
    const [, ms] = await time(() => checkSnapshot(createSnapshot(config, s)));
    prep.push(ms);
  }
  prep.sort((a, b) => a - b);
  console.log(
    `\ncomponents (start tick 6000)\n  snapshot preparation (createSnapshot + checkSnapshot): median ${(prep[10] as number).toFixed(1)} ms of 20`,
  );
  for (const h of [9_000, 18_000, 36_000]) {
    const [, ms] = await time(() => simulate(config, s, [], h, { yieldEvery: 1_000_000 }));
    console.log(
      `  one trajectory, ${h} ticks: ${(ms / 1000).toFixed(2)} s (${((ms / h) * 1000).toFixed(1)} µs/tick)`,
    );
  }
  for (const [h, b] of [
    [36_000, 8],
    [18_000, 12],
  ] as const) {
    const snap = createSnapshot(config, s);
    const [e, ms] = await time(() =>
      optimizeStandby(snap, { horizon_ticks: h, max_evaluations: b }, { yieldEvery: 1_000_000 }),
    );
    console.log(
      `  full evaluation, horizon ${h}, budget ${b}: ${(ms / 1000).toFixed(1)} s · ${e.search.simulations} simulations · ${e.recommendation ? "recommendation" : "none"} · plan in effect ${currentPlan(s).assignments.length} trucks`,
    );
  }
}

if (process.argv.includes("--robustness")) {
  const dir = new URL("../../../data/fixtures/twin-standby/", import.meta.url);
  const snap = JSON.parse(readFileSync(new URL("snapshot.json", dir), "utf8")) as ReturnType<
    typeof createSnapshot
  >;
  const discovery = JSON.parse(
    readFileSync(new URL("evaluation-recommended.json", dir), "utf8"),
  ) as Evaluation;
  const id = discovery.recommendation?.candidate_id ?? "c1";
  console.log(
    `\nrobustness (golden fixture, candidate ${id}, horizon ${discovery.options.horizon_ticks} ticks, root seed "bench", inline)`,
  );
  for (const seeds of [1, 5, 10, 20, 30]) {
    const run = () =>
      evaluateRobustness(snap, discovery, id, { seeds, root_seed: "bench" }, { yieldEvery: 1e9 });
    const t = performance.now();
    const r = await run();
    const ms = performance.now() - t;
    const again = await run();
    const same =
      JSON.stringify({ ...r, runtime: null }) === JSON.stringify({ ...again, runtime: null });
    const w = r.metrics.find((m) => m.key === "pickup_wait_s");
    console.log(
      `  ${String(seeds).padStart(2)} seeds: ${(ms / 1000).toFixed(1)} s (${(ms / seeds / 1000).toFixed(2)} s/seed) · ${r.verdict} · wait change ${w?.mean_diff ?? "-"} s (${w?.relative_pct ?? "-"} %), 95 % interval ${w?.ci95 ? `${w.ci95.low} … ${w.ci95.high}` : "-"} · better/worse/tied ${w ? `${w.seeds_better}/${w.seeds_worse}/${w.seeds_tied}` : "-"} · failed seeds [${r.per_seed
        .filter((x) => !x.passed)
        .map((x) => x.index)
        .join(
          ", ",
        )}] · demand diverged on ${r.workload.diverged_seeds} · repeat identical: ${same}`,
    );
  }
}
