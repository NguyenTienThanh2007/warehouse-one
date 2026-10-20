/**
 * Simulation throughput benchmark (headless, no rendering).
 * Measures wall-clock cost of `step()` for layouts of increasing size with the synthetic workload on.
 * Usage: pnpm bench:sim [-- --ticks 2000]
 */
import { createFoundationDemoConfig, createInitialState, step } from "../src/index";

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
console.log("size              | mean µs/tick | p95 µs/tick | ticks/sec  | events");
for (const size of SIZES) {
  const config = createFoundationDemoConfig({ aisles: size.aisles, bays: size.bays });
  let state = createInitialState(config);
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
  const mean = (total * 1000) / TICKS;
  console.log(
    `${size.label.padEnd(17)} | ${mean.toFixed(1).padStart(12)} | ${percentile(samples, 95).toFixed(1).padStart(11)} | ${Math.round(
      TICKS / (total / 1000),
    )
      .toLocaleString("en-US")
      .padStart(10)} | ${events}`,
  );
}
console.log("Note: Phase 0 simulates inventory only; entity-heavy systems arrive in Phase 2.");
