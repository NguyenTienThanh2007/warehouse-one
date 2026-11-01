/**
 * Optimiser benchmark (Phase 6): runs the fleet-standby strategy on the logistics park from fixed
 * start points and prints baseline vs recommendation, evaluations and wall time.
 *   pnpm bench:twin [-- --warm 6000,20000 --horizon 18000 --budget 8] [-- --components]
 * `--components` also times snapshot preparation, single trajectories per horizon and full
 * evaluations for the longer horizon and the maximum budget (all inline, one thread: the
 * reference the browser worker pool is compared with).
 */
import {
  createInitialState,
  createNetworkScenario,
  createSnapshot,
  step,
} from "@warehouse-one/simulation";
import { checkSnapshot, currentPlan, optimizeStandby, simulate } from "../src/index";

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
