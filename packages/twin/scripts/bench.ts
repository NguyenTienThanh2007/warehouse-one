/**
 * Optimiser benchmark (Phase 6): runs the fleet-standby strategy on the logistics park from fixed
 * start points and prints baseline vs recommendation, evaluations and wall time.
 *   pnpm bench:twin [-- --warm 6000,20000 --horizon 18000 --budget 8]
 */
import {
  createInitialState,
  createNetworkScenario,
  createSnapshot,
  step,
} from "@warehouse-one/simulation";
import { optimizeStandby } from "../src/index";

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
