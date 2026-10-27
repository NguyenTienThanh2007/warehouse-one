import {
  createInitialState,
  createNetworkScenario,
  createShowcaseScenario,
  createSnapshot,
  PARK_SITES,
  SimulationRunner,
  stateHash,
  step,
  type SimulationConfig,
  type SimulationState,
  type Snapshot,
} from "@warehouse-one/simulation";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compareMetrics,
  compareStandbyPlans,
  currentPlan,
  delta,
  fleetFingerprint,
  freshness,
  liveContext,
  makePlan,
  metricInfo,
  optimizeStandby,
  planCommands,
  simulate,
  sourceRef,
  TwinError,
  validatePlan,
  type Evaluation,
  type FleetMetrics,
  type StandbyPlan,
} from "./index";

const scenario = createNetworkScenario();
const config = scenario.config;

function stateAt(c: SimulationConfig, ticks: number): SimulationState {
  let s = step(c, createInitialState(c), scenario.openingCommands).state;
  while (s.tick < ticks) s = step(c, s).state;
  return s;
}

/** Deep-freeze, as the live runner publishes state, so any mutation would throw. */
function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

const without = (e: Evaluation) => ({ ...e, runtime: null });
const plan = (s: SimulationState, sites: Record<string, string | null>): StandbyPlan =>
  makePlan(
    currentPlan(s).assignments.map((a) => ({
      vehicle_id: a.vehicle_id,
      site_id: a.vehicle_id in sites ? (sites[a.vehicle_id] ?? null) : a.site_id,
    })),
  );

// Known benchmark scenario: the logistics park 10 simulated minutes in (`pnpm bench:twin`).
const OPTIONS = { horizon_ticks: 9_000, max_evaluations: 6 };
let start: SimulationState;
let snapshot: Snapshot;
let result: Evaluation;

beforeAll(async () => {
  start = freeze(stateAt(config, 6_000));
  snapshot = createSnapshot(config, start);
  result = await optimizeStandby(snapshot, OPTIONS);
}, 120_000);

describe("known scenario: the optimiser finds a better standby plan", () => {
  it("recommends a feasible plan that lowers the simulated pickup wait", () => {
    const rec = result.candidates.find(
      (c) => c.candidate_id === result.recommendation?.candidate_id,
    );
    expect(rec).toBeDefined();
    expect(rec?.verdict).toBe("recommended");
    expect(rec?.feasible).toBe(true);
    expect(rec?.constraints.every((c) => c.satisfied)).toBe(true);
    expect(rec?.constraints.map((c) => c.id)).toEqual([
      "fleet_coverage",
      "site_eligibility",
      "stall_capacity",
      "commands_accepted",
      "engine_invariants",
      "service_level",
      "no_extra_cancellations",
    ]);
    const wait = rec?.deltas.find((d) => d.key === "pickup_wait_s");
    expect(wait?.improved).toBe(true);
    expect(wait?.pct).toBeLessThanOrEqual(-5);
    expect((wait?.baseline ?? 0) - (wait?.candidate ?? 0)).toBeGreaterThanOrEqual(2);
    expect(result.search.simulations).toBeLessThanOrEqual(OPTIONS.max_evaluations);
    expect(result.recommendation?.reasons.join(" ")).toMatch(/Simulated over the next 15 minutes/);
  });

  it("computes deltas by the same rules for every candidate", () => {
    for (const c of result.candidates) {
      if (!c.metrics) continue;
      expect(c.deltas).toEqual(compareMetrics(result.baseline.metrics, c.metrics));
      for (const d of c.deltas)
        if (d.abs !== null)
          expect(d.abs).toBeCloseTo((d.candidate as number) - (d.baseline as number), 6);
    }
  });

  it("the recommended plan's commands are accepted by the engine itself", () => {
    const rec = result.candidates.find(
      (c) => c.verdict === "recommended",
    ) as Evaluation["candidates"][number];
    const r = step(config, start, planCommands(currentPlan(start), rec.plan, "apply"));
    expect(r.rejections).toEqual([]);
    expect(currentPlan(r.state)).toEqual(rec.plan);
  });

  it("is reproducible: identical inputs give identical results", async () => {
    const again = await optimizeStandby(createSnapshot(config, start), OPTIONS);
    expect(without(again)).toEqual(without(result));
    expect(again.evaluation_id).toBe(result.evaluation_id);
  }, 120_000);

  it("never touches the state it evaluates (frozen input, identical hash)", () => {
    expect(stateHash(config, start)).toBe(snapshot.state_hash);
    expect(result.source.state_hash).toBe(snapshot.state_hash);
    expect(result.source.fleet_fingerprint).toBe(fleetFingerprint(start));
  });
});

describe("isolation from the live simulation", () => {
  it("a what-if run while the live runner keeps going leaves the live run unchanged", async () => {
    const live = new SimulationRunner(config);
    for (const c of scenario.openingCommands) live.submit(c);
    for (let i = 0; i < 200; i++) live.stepOnce();
    const snap = live.snapshot();
    const beforeHash = stateHash(config, live.state);
    const reference = new SimulationRunner(config);
    for (const c of scenario.openingCommands) reference.submit(c);
    for (let i = 0; i < 200; i++) reference.stepOnce();

    const fleet = Object.keys(snap.state.network?.vehicles ?? {}).sort();
    const evaluation = compareStandbyPlans(
      snap,
      [{ plan: plan(snap.state, { [fleet[0] as string]: PARK_SITES.terminal }) }],
      { horizon_ticks: 3_000, max_evaluations: 2 },
      { yieldEvery: 100 },
    );
    for (let i = 0; i < 50; i++) {
      live.stepOnce();
      reference.stepOnce();
      await new Promise((r) => setTimeout(r, 0));
    }
    await evaluation;
    expect(stateHash(config, snap.state)).toBe(beforeHash);
    expect(stateHash(config, live.state)).toBe(stateHash(config, reference.state));
    expect(live.state.network?.vehicles[fleet[0] as string]?.standby_site).toBeUndefined();
  }, 60_000);

  it("concurrent evaluations of one snapshot equal sequential ones", async () => {
    const s = freeze(stateAt(config, 3_000));
    const snap = createSnapshot(config, s);
    const fleet = Object.keys(s.network?.vehicles ?? {}).sort();
    const a = plan(s, { [fleet[0] as string]: PARK_SITES.crossDock });
    const b = plan(s, { [fleet[1] as string]: PARK_SITES.terminal });
    const one = (p: StandbyPlan) =>
      simulate(config, s, planCommands(currentPlan(s), p, "x"), 2_000, { yieldEvery: 50 });
    const [ca, cb] = await Promise.all([one(a), one(b)]);
    expect(await one(a)).toEqual(ca);
    expect(await one(b)).toEqual(cb);
    expect(stateHash(config, s)).toBe(snap.state_hash);
  }, 60_000);
});

describe("no improvement is reported honestly", () => {
  it("without transfers nothing is recommended and ratios are not invented", async () => {
    const quiet: SimulationConfig = {
      ...config,
      network: { ...(config.network as NonNullable<SimulationConfig["network"]>), lanes: [] },
    };
    const s = stateAt(quiet, 600);
    const e = await optimizeStandby(createSnapshot(quiet, s), {
      horizon_ticks: 3_000,
      max_evaluations: 2,
    });
    expect(e.recommendation).toBeNull();
    expect(e.baseline.metrics.transfers_planned).toBe(0);
    expect(e.baseline.metrics.pickup_wait_s).toBeNull();
    expect(e.no_recommendation_reason).toMatch(/No transfer is planned/);
    expect(e.candidates.every((c) => c.verdict !== "recommended")).toBe(true);
  }, 60_000);

  it("a plan equal to the one in effect is no better than itself", async () => {
    const e = await compareStandbyPlans(
      snapshot,
      [{ label: "Unchanged", plan: currentPlan(start) }],
      { horizon_ticks: 3_000, max_evaluations: 2 },
    );
    const c = e.candidates[0];
    expect(c?.verdict).toBe("no_better");
    expect(c?.metrics).toEqual(e.baseline.metrics);
    expect(c?.deltas.find((d) => d.key === "pickup_wait_s")).toMatchObject({
      abs: 0,
      pct: 0,
      improved: false,
    });
    expect(e.recommendation).toBeNull();
  }, 60_000);
});

describe("hard constraints cannot be bypassed", () => {
  it("an over-capacity plan is infeasible, never simulated, and refused by the engine too", async () => {
    const fleet = Object.keys(start.network?.vehicles ?? {}).sort();
    const greedy = plan(
      start,
      Object.fromEntries(fleet.slice(0, 4).map((v) => [v, PARK_SITES.terminal])),
    );
    const e = await compareStandbyPlans(snapshot, [{ plan: greedy }], {
      horizon_ticks: 3_000,
      max_evaluations: 2,
    });
    const c = e.candidates[0];
    expect(c?.verdict).toBe("infeasible");
    expect(c?.metrics).toBeNull();
    expect(c?.constraints.find((x) => x.id === "stall_capacity")?.satisfied).toBe(false);
    expect(e.recommendation).toBeNull();
    const r = step(config, start, planCommands(currentPlan(start), greedy, "force"));
    expect(r.rejections.map((x) => x.code)).toContain("INVALID_STANDBY");
  }, 60_000);

  it("rejects unknown, missing, duplicated trucks and ineligible sites", () => {
    const fleet = Object.keys(start.network?.vehicles ?? {}).sort();
    const bad = makePlan([
      { vehicle_id: "lh-ghost", site_id: null },
      { vehicle_id: fleet[0] as string, site_id: PARK_SITES.gateway },
      { vehicle_id: fleet[0] as string, site_id: PARK_SITES.depot },
    ]);
    const c = validatePlan(config, start, bad);
    expect(c.find((x) => x.id === "fleet_coverage")?.detail).toMatch(
      /unknown: lh-ghost.*missing.*twice/,
    );
    expect(c.find((x) => x.id === "site_eligibility")?.satisfied).toBe(false);
  });
});

describe("inputs and failures", () => {
  it("refuses a single-site snapshot, a tampered snapshot and invalid options", async () => {
    const show = createShowcaseScenario().config;
    const showSnap = createSnapshot(show, createInitialState(show));
    await expect(optimizeStandby(showSnap)).rejects.toMatchObject({ code: "NO_NETWORK" });
    const tampered = { ...snapshot, state_hash: "0".repeat(32) };
    await expect(optimizeStandby(tampered)).rejects.toMatchObject({ code: "INVALID_SNAPSHOT" });
    await expect(optimizeStandby(snapshot, { horizon_ticks: 10 })).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    await expect(optimizeStandby(snapshot, { max_evaluations: 99 })).rejects.toBeInstanceOf(
      TwinError,
    );
  });

  it("stops when cancelled", async () => {
    const ctl = new AbortController();
    const p = optimizeStandby(snapshot, OPTIONS, { signal: ctl.signal, yieldEvery: 100 });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("freshness of a proposal's source", () => {
  const src = () => sourceRef(config, start);
  it("is fresh for the same run within the age limit", () => {
    expect(freshness(src(), { ...liveContext(config, start), tick: start.tick + 100 })).toEqual({
      fresh: true,
      age_ticks: 100,
    });
  });
  it("is stale for another run, a reset run, a changed fleet or too old", () => {
    const live = liveContext(config, start);
    expect(freshness(src(), { ...live, simulation_id: "other" })).toMatchObject({
      reason: "other_run",
    });
    expect(freshness(src(), { ...live, tick: start.tick - 1 })).toMatchObject({
      reason: "run_restarted",
    });
    expect(freshness(src(), { ...live, fleet_fingerprint: "x" })).toMatchObject({
      reason: "fleet_changed",
    });
    expect(freshness(src(), { ...live, tick: start.tick + 18_001 })).toMatchObject({
      reason: "too_old",
    });
  });
});

describe("deltas", () => {
  it("never divides by a zero or missing baseline", () => {
    const wait = metricInfo("pickup_wait_s");
    expect(delta(wait, 0, 5)).toMatchObject({ abs: 5, pct: null, improved: false });
    expect(delta(wait, null, 5)).toMatchObject({ abs: null, pct: null, improved: null });
    expect(delta(wait, 80, 60)).toMatchObject({ abs: -20, pct: -25, improved: true, unit: "s" });
    expect(delta(metricInfo("pallets_delivered"), 100, 110)).toMatchObject({
      pct: 10,
      improved: true,
    });
    expect(delta(metricInfo("transfers_planned"), 10, 12)).toMatchObject({ improved: null });
  });
  it("covers every metric once", () => {
    const m = result.baseline.metrics;
    expect(
      compareMetrics(m, m)
        .map((d) => d.key)
        .sort(),
    ).toEqual(Object.keys(m as FleetMetrics).sort());
  });
});
