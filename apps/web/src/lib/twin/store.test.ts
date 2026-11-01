import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Progress } from "@warehouse-one/twin";
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
