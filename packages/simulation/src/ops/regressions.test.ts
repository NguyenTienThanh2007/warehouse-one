import type { SimulationCommand } from "@warehouse-one/contracts";
import { describe, expect, it } from "vitest";
import {
  checkInvariants,
  createInitialState,
  createScenario,
  loadSnapshot,
  navGraph,
  replay,
  serializeSnapshot,
  SimulationRunner,
  stateHash,
  step,
  type ScenarioId,
  type SimulationConfig,
  type SimulationState,
} from "../index";

/**
 * Regression tests for the Phase 2 traffic livelock (two vehicles meeting head-on in a single-lane
 * aisle and endlessly backing off) and the benchmark workload that never produced work.
 */

describe("one-way circulation (root cause: head-on meetings in single-lane aisles)", () => {
  it.each(["showcase", "bench-100", "bench-1000"] as const)(
    "%s: two-way travel only exists inside exclusive dead-end zones",
    (id) => {
      const g = navGraph(createScenario(id).config);
      expect(g.problems).toEqual([]);
      for (const [a, edges] of g.adjacency) {
        for (const e of edges) {
          const back = g.adjacency.get(e.to)?.some((x) => x.to === a);
          if (!back) continue;
          const na = g.nodes.get(a)!;
          const nb = g.nodes.get(e.to)!;
          // A two-way edge lies in a dock path / the road, or is a charger spur.
          expect(
            na.zone !== null || nb.zone !== null || na.kind === "charger" || nb.kind === "charger",
            `${a}↔${e.to}`,
          ).toBe(true);
        }
      }
    },
  );
});

/** Run with a given seed, checking invariants; return liveness measurements. */
function run(id: ScenarioId, seed: string, ticks: number) {
  const scenario = createScenario(id);
  const config: SimulationConfig = { ...scenario.config, seed };
  const opened = step(config, createInitialState(config), scenario.openingCommands);
  let s = opened.state;
  // Tasks created by the opening commands count too: their completions are counted below.
  let created = opened.events.filter((e) => e.event_type === "task.created").length;
  let completed = 0;
  let longestWait = 0;
  const windows = new Set<number>();
  for (let i = 0; i < ticks; i++) {
    const r = step(config, s, []);
    s = r.state;
    for (const e of r.events) {
      if (e.event_type === "task.created") created++;
      if (e.event_type === "task.completed") {
        completed++;
        windows.add(Math.floor(s.tick / 2500));
      }
    }
    for (const e of Object.values(s.ops!.equipment))
      longestWait = Math.max(longestWait, e.wait_ticks);
    if (i % 250 === 0) expect(checkInvariants(config, s)).toEqual([]);
  }
  return { created, completed, longestWait, windows, backlog: Object.keys(s.ops!.tasks).length };
}

describe("liveness across seeds and layouts", () => {
  it.each([
    ["showcase", "regression-1"],
    ["showcase", "regression-2"],
    ["showcase", "regression-3"],
    ["bench-1000", "regression-1"],
    ["bench-1000", "regression-2"],
  ] as const)(
    "%s seed %s: no standstill, work keeps flowing for 15,000 ticks",
    (id, seed) => {
      const r = run(id, seed, 15000);
      // The livelock produced waits of thousands of ticks; queueing behind a working vehicle is short.
      expect(r.longestWait).toBeLessThan(300);
      // Every 2,500-tick window completes work, and completions keep pace with demand.
      for (let w = 0; w < 6; w++) expect(r.windows.has(w), `window ${w}`).toBe(true);
      expect(r.completed / r.created).toBeGreaterThan(0.85);
      expect(r.backlog).toBeLessThan(20);
      // Benchmark relocations must actually happen (the workload once picked full bays and stalled).
      expect(r.completed).toBeGreaterThan(id === "bench-1000" ? 30 : 50);
    },
    // 15,000 simulated ticks: 1.5–2.6 s locally, 2.1–3.8 s on main's CI runs (39560402887,
    // 39579726922) and up to 5.1 s on a slower runner (39608774781), past Vitest's 5 s default.
    // Same explicit limit as the 20,000-tick soak runs.
    30_000,
  );
});

describe("determinism with operations running", () => {
  const scenario = createScenario("showcase");
  const config = scenario.config;
  const advance = (s: SimulationState, n: number) => {
    for (let i = 0; i < n; i++) s = step(config, s, []).state;
    return s;
  };
  const opened = () => step(config, createInitialState(config), scenario.openingCommands).state;

  it("produces identical state and events from the same inputs", () => {
    const a = advance(opened(), 4000);
    const b = advance(opened(), 4000);
    expect(stateHash(config, a)).toBe(stateHash(config, b));
    expect(Object.keys(a.ops!.tasks).length + a.sequence).toBeGreaterThan(0);
  });

  it("resumes identically from a snapshot taken mid-operation (vehicles moving and handling)", () => {
    const mid = advance(opened(), 2000);
    const moving = Object.values(mid.ops!.equipment).filter(
      (e) => e.status !== "idle" && e.status !== "charging",
    );
    expect(moving.length).toBeGreaterThan(0);
    const restored = loadSnapshot(
      serializeSnapshot({
        snapshot_version: 1,
        engine_version: "0.1.0",
        config,
        state: mid,
        state_hash: stateHash(config, mid),
      }),
    );
    expect(stateHash(config, advance(restored.state, 2000))).toBe(
      stateHash(config, advance(mid, 2000)),
    );
  });

  it("replays a runner's command log, including operator commands mid-run, to the same state", () => {
    const runner = new SimulationRunner(config);
    for (const c of scenario.openingCommands) runner.submit(c);
    for (let i = 0; i < 600; i++) runner.stepOnce();
    const stored = Object.values(runner.state.ops!.pallets).find(
      (p) => p.at.kind === "slot" && !p.order_id && !p.task_id,
    )!;
    runner.submit({
      command_id: "replay-relocate",
      type: "pallet.relocate",
      payload: { pallet_id: stored.id, to_location_id: "loc-00-001" },
    } as SimulationCommand);
    runner.submit({
      command_id: "replay-inbound",
      type: "truck.schedule_inbound",
      payload: { cargo: [{ sku: "sku-bulk-bags", quantity: 2 }] },
    } as SimulationCommand);
    for (let i = 0; i < 1400; i++) runner.stepOnce();
    const replayed = replay(config, runner.commandLog, runner.state.tick);
    expect(stateHash(config, replayed)).toBe(stateHash(config, runner.state));
  });
});
