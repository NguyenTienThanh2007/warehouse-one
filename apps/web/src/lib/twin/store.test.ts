import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Snapshot } from "@warehouse-one/simulation";
import type { Evaluation, Progress, RobustnessProgress } from "@warehouse-one/twin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RunEvaluation from "./run-evaluation";

// The store's collaborators: a controllable evaluation, a snapshot source and an API that is down.
const snapshot = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../../../data/fixtures/twin-standby/snapshot.json"),
    "utf8",
  ),
) as { config: unknown; state: unknown };
const h = vi.hoisted(() => ({
  onProgress: null as ((p: Progress) => void) | null,
  finish: null as (() => void) | null,
  robust: null as null | {
    onProgress: (p: RobustnessProgress) => void;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    mode: string;
    seeds: number | undefined;
  },
}));

vi.mock("../sim/store", () => ({
  useSimulation: { getState: () => ({ config: snapshot.config, state: snapshot.state }) },
  commandOutcomes: vi.fn(),
}));
vi.mock("./api", () => ({
  twinApi: { create: () => Promise.reject(new Error("API down")) },
}));
vi.mock("./run-evaluation", async (importOriginal) => {
  const real = await importOriginal<typeof RunEvaluation>();
  return {
    ...real,
    runEvaluation: (_request: unknown, onProgress: (p: Progress) => void) =>
      new Promise((resolve) => {
        h.onProgress = onProgress;
        h.finish = () =>
          resolve({
            evaluation: { candidates: [], recommendation: null },
            mode: "worker",
            workers: 4,
            elapsedMs: 1,
          });
      }),
    runRobustness: (
      _snapshot: unknown,
      _discovery: unknown,
      _id: string,
      options: { seeds?: number },
      onProgress: (p: RobustnessProgress) => void,
      signal: AbortSignal,
      mode: string,
    ) =>
      new Promise((resolve, reject) => {
        h.robust = { onProgress, resolve, reject, mode, seeds: options.seeds };
        signal.addEventListener("abort", () =>
          reject(new real.EvaluationFailed("CANCELLED", "cancelled")),
        );
      }),
  };
});

const { useTwin } = await import("./store");

const progress = (stage: Progress["stage"], done: number): Progress => ({
  stage,
  simulations_done: done,
  simulations_running: 1,
  simulations_budget: 8,
  label: "",
  fraction: done / 8,
});
const shown = () => {
  const ev = useTwin.getState().evaluation;
  return ev.kind === "running" ? ev.progress : null;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("evaluation progress in the workspace store", () => {
  it("shows a new stage at once and coalesces progress within a stage to one update per 250 ms", async () => {
    const run = useTwin.getState().optimize();
    let renders = 0;
    const stop = useTwin.subscribe(() => (renders += 1));
    h.onProgress?.(progress("simulating", 0));
    expect(shown()?.stage).toBe("simulating");
    for (let i = 1; i <= 20; i++) h.onProgress?.(progress("simulating", i / 10));
    expect(shown()?.simulations_done).toBe(0);
    vi.advanceTimersByTime(250);
    // Only the latest of the twenty is shown.
    expect(shown()?.simulations_done).toBe(2);
    expect(renders).toBe(2);
    h.onProgress?.(progress("simulating", 3));
    h.onProgress?.(progress("ranking", 8));
    expect(shown()?.stage).toBe("ranking");
    // The superseded update never lands after the newer stage.
    vi.advanceTimersByTime(1_000);
    expect(shown()?.stage).toBe("ranking");
    stop();
    h.finish?.();
    await run;
  });

  it("drops a pending update once the evaluation has finished", async () => {
    const run = useTwin.getState().optimize();
    h.onProgress?.(progress("simulating", 0));
    h.onProgress?.(progress("simulating", 5));
    h.finish?.();
    await run;
    vi.advanceTimersByTime(1_000);
    expect(useTwin.getState().evaluation.kind).toBe("done");
  });
});

describe("multi-seed validation in the workspace store (Phase 6.2)", () => {
  const discovery = { candidates: [{ candidate_id: "c1" }] } as unknown as Evaluation;
  const done = () =>
    useTwin.setState({
      evaluation: {
        kind: "done",
        result: discovery,
        snapshot: snapshot as unknown as Snapshot,
        run: null,
      },
      selected: "c1",
      robustness: { kind: "idle" },
      failed: null,
    });
  const rp = (stage: RobustnessProgress["stage"], seeds_done: number): RobustnessProgress => ({
    stage,
    seeds_total: 20,
    seeds_done,
    seeds_running: 2,
    label: "",
    fraction: seeds_done / 20,
  });

  it("runs the selected candidate with the chosen seed count, coalescing progress", async () => {
    done();
    useTwin.getState().setSeedCount(5);
    const run = useTwin.getState().validateRobustness();
    expect(h.robust?.seeds).toBe(5);
    expect(h.robust?.mode).toBe("worker");
    h.robust?.onProgress(rp("simulating", 0));
    for (let i = 1; i <= 10; i++) h.robust?.onProgress(rp("simulating", i));
    const r = useTwin.getState().robustness;
    expect(r.kind === "running" && r.progress?.seeds_done).toBe(0);
    vi.advanceTimersByTime(250);
    const later = useTwin.getState().robustness;
    expect(later.kind === "running" && later.progress?.seeds_done).toBe(10);
    h.robust?.resolve({
      robustness: { verdict: "inconclusive" },
      mode: "worker",
      workers: 4,
      elapsedMs: 9,
    });
    await run;
    expect(useTwin.getState().robustness).toMatchObject({
      kind: "done",
      result: { verdict: "inconclusive" },
      run: { mode: "worker", workers: 4 },
    });
  });

  it("a cancelled validation leaves no verdict", async () => {
    done();
    const run = useTwin.getState().validateRobustness();
    useTwin.getState().cancelRobustness();
    await run;
    expect(useTwin.getState().robustness.kind).toBe("cancelled");
  });

  it("a worker failure leaves no verdict and offers the main thread explicitly", async () => {
    done();
    const { EvaluationFailed } = await import("./run-evaluation");
    const run = useTwin.getState().validateRobustness();
    h.robust?.reject(new EvaluationFailed("WORKER_CRASHED", "An evaluation worker crashed."));
    await run;
    const s = useTwin.getState();
    expect(s.robustness.kind).toBe("idle");
    expect(s.failed).toMatchObject({ op: "robustness", failure: { code: "WORKER_CRASHED" } });
    expect(s.failed?.alternative?.label).toContain("main thread");
    const again = s.failed?.alternative?.run();
    expect(h.robust?.mode).toBe("main_thread");
    h.robust?.resolve({
      robustness: { verdict: "improved" },
      mode: "main_thread",
      workers: 0,
      elapsedMs: 9,
    });
    await again;
    expect(useTwin.getState().robustness).toMatchObject({
      kind: "done",
      run: { mode: "main_thread" },
    });
  });

  it("a new evaluation stops a running validation and clears an old verdict", async () => {
    done();
    const validation = useTwin.getState().validateRobustness();
    const optimisation = useTwin.getState().optimize();
    await validation;
    expect(useTwin.getState().robustness.kind).toBe("idle");
    h.finish?.();
    await optimisation;
  });

  it("does nothing without a snapshot (a proposal loaded from the API)", async () => {
    done();
    useTwin.setState({
      evaluation: { kind: "done", result: discovery, snapshot: null, run: null },
    });
    h.robust = null;
    await useTwin.getState().validateRobustness();
    expect(h.robust).toBeNull();
    expect(useTwin.getState().robustness.kind).toBe("idle");
  });
});
