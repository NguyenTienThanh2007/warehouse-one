import { createSnapshot, type Snapshot } from "@warehouse-one/simulation";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURE_OPTIONS } from "./fixture";
import { simulate, type Trajectory } from "./metrics";
import { optimizeStandby, type Evaluation, type Progress } from "./optimizer";
import { inlineExecutor, type TrajectoryExecutor } from "./executor";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/fixtures/twin-standby");
const snapshot = JSON.parse(readFileSync(resolve(dir, "snapshot.json"), "utf8")) as Snapshot;
const golden = JSON.parse(
  readFileSync(resolve(dir, "evaluation-recommended.json"), "utf8"),
) as Evaluation;
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const withoutRuntime = (e: Evaluation) => json({ ...e, runtime: null });

/**
 * Runs a batch concurrently, finishing jobs in reverse order, like a worker pool would in the
 * worst case. Results must not depend on it.
 */
function concurrent(parallelism: number, log: number[] = []): TrajectoryExecutor {
  return {
    mode: "worker",
    parallelism,
    async run(jobs, ctx) {
      expect(jobs.length).toBeLessThanOrEqual(Math.max(parallelism, jobs.length));
      log.push(jobs.length);
      const results = await Promise.all(
        jobs.map(async (job, i) => {
          // Later jobs start first: completion order is reversed.
          await new Promise((r) => setTimeout(r, (jobs.length - i) * 2));
          return simulate(ctx.config, ctx.state, job.commands, ctx.horizon, {
            signal: ctx.signal,
            onTicks: (n) => ctx.onTicks(i, n),
            yieldEvery: 1000,
          });
        }),
      );
      return results as Trajectory[];
    },
  };
}

describe("evaluation is independent of where and in what order trajectories run", () => {
  it.each([1, 2, 3, 4, 8])(
    "parallelism %i reproduces the golden evaluation exactly",
    async (p) => {
      const batches: number[] = [];
      const e = await optimizeStandby(snapshot, FIXTURE_OPTIONS, {
        executor: concurrent(p, batches),
      });
      expect(withoutRuntime(e)).toEqual(withoutRuntime(golden));
      expect(e.runtime.ticks_simulated).toBe(golden.runtime.ticks_simulated);
      // The first batch holds the baseline and every initial candidate the budget allows.
      expect(batches[0]).toBeGreaterThan(1);
      if (p === 1) expect(batches.slice(1).every((n) => n === 1)).toBe(true);
    },
    120_000,
  );

  it("reports stages and never overshoots, even with speculative simulations", async () => {
    const seen: Progress[] = [];
    // Budget 8: the first batch uses 6 (baseline + 5 candidates), local search the rest.
    await optimizeStandby(
      createSnapshot(snapshot.config, snapshot.state),
      { horizon_ticks: 9_000, max_evaluations: 8 },
      {
        executor: concurrent(4),
        onProgress: (p) => seen.push(p),
      },
    );
    expect(seen[0]?.stage).toBe("validating");
    expect(seen.at(-1)?.stage).toBe("done");
    expect(seen.some((p) => p.stage === "simulating" && p.simulations_running > 1)).toBe(true);
    for (const p of seen) {
      expect(p.fraction).toBeGreaterThanOrEqual(0);
      expect(p.fraction).toBeLessThanOrEqual(1);
      expect(p.simulations_done).toBeLessThanOrEqual(p.simulations_budget);
    }
    const stages = [...new Set(seen.map((p) => p.stage))];
    expect(stages).toEqual(["validating", "simulating", "searching", "ranking", "done"]);
  }, 120_000);

  it("the inline executor is the default", () => {
    expect(inlineExecutor.parallelism).toBe(1);
    expect(inlineExecutor.mode).toBe("inline");
  });
});
