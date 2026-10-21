/**
 * Simulation throughput benchmark (headless, no rendering).
 * Measures wall-clock cost of `step()`:
 * - Phase 0 inventory-only layouts of increasing size with the synthetic inventory workload;
 * - Phase 2 operational scenarios (vehicles, routing, tasks, trucks) with their seeded workload.
 * Usage: pnpm bench:sim [-- --ticks 2000]
 */
import {
  createFoundationDemoConfig,
  createInitialState,
  createScenario,
  step,
  type ScenarioId,
  type SimulationConfig,
  type SimulationState,
} from "../src/index";

const ticksArg = process.argv.indexOf("--ticks");
const TICKS = ticksArg > 0 ? Number(process.argv[ticksArg + 1]) : 2000;
const SIZES = [
  { label: "100 locations", aisles: 4, bays: 25 },
  { label: "300 locations", aisles: 6, bays: 50 },
  { label: "1,000 locations", aisles: 10, bays: 100 },
];

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
}

console.log(
  `node ${process.version} ${process.platform}/${process.arch} — ${TICKS} ticks per size (after 200 warm-up)`,
);
function measure(config: SimulationConfig, start: SimulationState) {
  let state = start;
  for (let i = 0; i < 200; i++) state = step(config, state).state;
  const samples: number[] = [];
  let events = 0;
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) {
    const s = performance.now();
    const r = step(config, state);
    samples.push((performance.now() - s) * 1000);
    events += r.events.length;
    state = r.state;
  }
  const total = performance.now() - t0;
  samples.sort((a, b) => a - b);
  return {
    mean: (total * 1000) / TICKS,
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    rate: Math.round(TICKS / (total / 1000)),
    events,
    state,
  };
}

const row = (label: string, m: ReturnType<typeof measure>, extra = "") =>
  console.log(
    `${label.padEnd(26)} | ${m.mean.toFixed(1).padStart(12)} | ${m.p95.toFixed(1).padStart(11)} | ${m.p99
      .toFixed(1)
      .padStart(
        11,
      )} | ${m.rate.toLocaleString("en-US").padStart(10)} | ${String(m.events).padStart(6)}${extra}`,
  );

const header =
  "scenario                   | mean µs/tick | p95 µs/tick | p99 µs/tick | ticks/sec  | events";
console.log("Phase 0 · inventory only");
console.log(header);
for (const size of SIZES) {
  const config = createFoundationDemoConfig({ aisles: size.aisles, bays: size.bays });
  row(size.label, measure(config, createInitialState(config)));
}

console.log("\nPhase 2 · operations (vehicles, routing, tasks, trucks; seeded workload)");
console.log(header + " | tasks open");
for (const id of ["showcase", "bench-100", "bench-300", "bench-1000"] as ScenarioId[]) {
  const scenario = createScenario(id);
  const config = scenario.config;
  const opened = step(config, createInitialState(config), scenario.openingCommands).state;
  const m = measure(config, opened);
  row(id, m, ` | ${Object.keys(m.state.ops?.tasks ?? {}).length}`);
}
console.log(
  "\nReal time at 1× needs 10 ticks/sec; the UI's 8× needs 80. Laptop runs can differ by 10–20%; compare runs side by side.",
);
