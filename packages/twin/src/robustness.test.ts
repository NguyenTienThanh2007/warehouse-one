import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { seedRng, stateHash, type Snapshot } from "@warehouse-one/simulation";
import { beforeAll, describe, expect, it } from "vitest";
import type { TrajectoryExecutor, TrajectoryJob } from "./executor";
import { simulate } from "./metrics";
import { optimizeStandby, TwinError, type Evaluation } from "./optimizer";
import { currentPlan, planCommands } from "./plan";
import {
  checkRobustnessOptions,
  defaultRootSeed,
  evaluateRobustness,
  SEEDS_PER_BATCH,
  seededStarts,
  seedString,
  type RobustnessEvaluation,
} from "./robustness";

const dir = resolve(__dirname, "../../../data/fixtures/twin-standby");
const snapshot = JSON.parse(readFileSync(resolve(dir, "snapshot.json"), "utf8")) as Snapshot;
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const withoutRuntime = (r: RobustnessEvaluation) => json({ ...r, runtime: null });

function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

/** Runs a batch concurrently with jobs finishing in reverse order; records batch sizes. */
function reversed(parallelism: number, sizes: number[] = []): TrajectoryExecutor {
  return {
    mode: "worker",
    parallelism,
    async run(jobs: readonly TrajectoryJob[], ctx) {
      sizes.push(jobs.length);
      return Promise.all(
        jobs.map(async (j, i) => {
          await new Promise((r) => setTimeout(r, (jobs.length - i) * 2));
          return simulate(ctx.config, j.start?.state ?? ctx.state, j.commands, ctx.horizon, {
            signal: ctx.signal,
            onTicks: (t) => ctx.onTicks(i, t),
          });
        }),
      );
    },
  };
}

// A short discovery run (5 simulated minutes) keeps these tests quick.
let discovery: Evaluation;
let candidateId: string;
beforeAll(async () => {
  discovery = await optimizeStandby(snapshot, { horizon_ticks: 3_000, max_evaluations: 3 });
  const c = discovery.candidates.find((x) => x.feasible && x.metrics);
  if (!c) throw new Error("fixture has no feasible candidate");
  candidateId = c.candidate_id;
}, 60_000);

describe("seeds", () => {
  it("are derived deterministically, never repeat and never reuse the discovery stream", () => {
    const a = seededStarts(snapshot.state, "r1", 30);
    expect(seededStarts(snapshot.state, "r1", 30)).toEqual(a);
    expect(a.map((s) => s.seed)).toEqual(
      Array.from({ length: 30 }, (_, i) => seedString("r1", i + 1)),
    );
    const keys = new Set(a.map((s) => s.rng.join(",")));
    expect(keys.size).toBe(30);
    expect(keys.has(snapshot.state.rng.join(","))).toBe(false);
    expect(a[0]?.rng).toEqual(seedRng("twin-robustness:r1:1"));
    // Another root gives other futures.
    expect(seededStarts(snapshot.state, "r2", 1)[0]?.rng).not.toEqual(a[0]?.rng);
  });

  it("refuses a seed that repeats the discovery stream", () => {
    const state = { ...snapshot.state, rng: seedRng(seedString("r1", 2)) };
    expect(() => seededStarts(state, "r1", 3)).toThrow(TwinError);
  });

  it("rejects invalid seed configurations", () => {
    for (const bad of [
      { seeds: 0 },
      { seeds: 31 },
      { seeds: 2.5 },
      { root_seed: "a b" },
      { root_seed: "" },
    ])
      expect(() => checkRobustnessOptions(snapshot, bad)).toThrow(TwinError);
    expect(checkRobustnessOptions(snapshot)).toEqual({
      seeds: 20,
      root_seed: defaultRootSeed(snapshot),
    });
  });
});

describe("multi-seed evaluation with the real engine", () => {
  let first: RobustnessEvaluation;

  it("pairs baseline and candidate on the same seeded start state, applying the optimiser's commands", async () => {
    const frozen = freeze(structuredClone(snapshot));
    first = await evaluateRobustness(frozen, discovery, candidateId, { seeds: 5, root_seed: "t" });
    // The input is untouched.
    expect(stateHash(frozen.config, frozen.state)).toBe(snapshot.state_hash);
    expect(first.per_seed.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    const base = currentPlan(snapshot.state);
    const candidate = discovery.candidates.find((c) => c.candidate_id === candidateId);
    const commands = planCommands(base, candidate?.plan ?? base, `twin-${candidateId.slice(1)}`);
    // Seed 2, recomputed directly: same start for both plans, same numbers.
    const seeded = { ...snapshot.state, rng: seedRng(seedString("t", 2)) };
    const s2 = first.per_seed[1];
    expect(s2?.start_state_hash).toBe(stateHash(snapshot.config, seeded));
    const b = await simulate(snapshot.config, seeded, [], 3_000);
    const c = await simulate(snapshot.config, seeded, commands, 3_000);
    expect(json(s2?.baseline.metrics)).toEqual(json(b.metrics));
    expect(json(s2?.candidate.metrics)).toEqual(json(c.metrics));
    // On the discovery stream, the same commands reproduce the optimiser's own numbers.
    const live = await simulate(snapshot.config, snapshot.state, commands, 3_000);
    expect(json(live.metrics)).toEqual(json(candidate?.metrics));
    // Different seeds are different futures.
    expect(new Set(first.per_seed.map((s) => s.baseline.end_state_hash)).size).toBe(5);
    // Every observation is kept, and the statistics are computed from them.
    const waits = first.per_seed.map((s) => s.deltas.pickup_wait_s);
    const primary = first.metrics.find((m) => m.key === "pickup_wait_s");
    const valid = waits.filter((x): x is number => x !== null);
    expect(primary?.n).toBe(valid.length);
    expect(primary?.mean_diff).toBeCloseTo(valid.reduce((x, y) => x + y, 0) / valid.length, 3);
  }, 120_000);

  it("is reproducible and independent of how jobs are scheduled", async () => {
    const sizes: number[] = [];
    const again = await evaluateRobustness(
      snapshot,
      discovery,
      candidateId,
      { seeds: 5, root_seed: "t" },
      { executor: reversed(4, sizes) },
    );
    expect(withoutRuntime(again)).toEqual(withoutRuntime(first));
    expect(again.robustness_id).toBe(first.robustness_id);
    expect(sizes).toEqual([10]);
    // Another root seed is another evaluation.
    const other = await evaluateRobustness(snapshot, discovery, candidateId, {
      seeds: 5,
      root_seed: "u",
    });
    expect(other.robustness_id).not.toBe(first.robustness_id);
  }, 120_000);

  it("runs seeds in bounded batches of at most 16 jobs, in seed order", async () => {
    const sizes: number[] = [];
    const r = await evaluateRobustness(
      snapshot,
      discovery,
      candidateId,
      { seeds: SEEDS_PER_BATCH + 2, root_seed: "t" },
      { executor: reversed(4, sizes) },
    );
    expect(sizes).toEqual([16, 4]);
    expect(r.per_seed.map((s) => s.index)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    // The first five seeds are the same five as before.
    expect(json(r.per_seed.slice(0, 5))).toEqual(json(first.per_seed));
  }, 120_000);

  it("reports progress by seed and stage", async () => {
    const stages: string[] = [];
    let last = { seeds_done: 0, seeds_total: 0 };
    await evaluateRobustness(
      snapshot,
      discovery,
      candidateId,
      { seeds: 2, root_seed: "t" },
      {
        onProgress: (p) => {
          if (stages.at(-1) !== p.stage) stages.push(p.stage);
          last = p;
        },
      },
    );
    expect(stages).toEqual(["validating", "simulating", "aggregating", "done"]);
    expect(last).toMatchObject({ seeds_done: 2, seeds_total: 2 });
  }, 60_000);

  it("a cancelled evaluation stops and produces no verdict", async () => {
    const ctl = new AbortController();
    const run = evaluateRobustness(
      snapshot,
      discovery,
      candidateId,
      { seeds: 30, root_seed: "t" },
      {
        signal: ctl.signal,
        onProgress: (p) => {
          if (p.seeds_done >= 1) ctl.abort();
        },
      },
    );
    await expect(run).rejects.toMatchObject({ code: "CANCELLED" });
  }, 60_000);

  it("refuses a snapshot the evaluation did not start from, or an unknown candidate", async () => {
    const moved = { ...snapshot, state_hash: "0".repeat(32) };
    await expect(evaluateRobustness(moved, discovery, candidateId)).rejects.toMatchObject({
      code: "INVALID_SNAPSHOT",
    });
    await expect(evaluateRobustness(snapshot, discovery, "c99")).rejects.toMatchObject({
      code: "INVALID_PLAN",
    });
  });

  it("records what was evaluated, how, and its limits", () => {
    expect(first).toMatchObject({
      method: { id: "paired-t-95" },
      discovery: { evaluation_id: discovery.evaluation_id },
      seeds: { root_seed: "t", count: 5 },
      options: { horizon_ticks: 3_000, min_improvement_pct: 5, min_improvement_s: 2 },
      primary: "pickup_wait_s",
    });
    expect(first.limitations.join(" ")).toContain("not stored with the proposal");
    expect(first.workload.diverged_seeds).toBe(
      first.per_seed.filter((s) => s.workload_diverged).length,
    );
  });
});
