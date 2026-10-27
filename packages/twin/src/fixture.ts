import {
  createInitialState,
  createNetworkScenario,
  createSnapshot,
  step,
  type Snapshot,
} from "@warehouse-one/simulation";
import { optimizeStandby, compareStandbyPlans, type Evaluation } from "./optimizer";
import { currentPlan } from "./plan";

/**
 * The reference evaluation (data/fixtures/twin-standby): the logistics park 10 simulated minutes
 * in, optimised with a short horizon. Shared by the fixture generator, the golden test and the
 * API's tests, so the Python side validates exactly what the TypeScript optimiser produces.
 */
export const FIXTURE_TICK = 6_000;
export const FIXTURE_OPTIONS = { horizon_ticks: 9_000, max_evaluations: 6 } as const;

export interface TwinFixture {
  readonly snapshot: Snapshot;
  /** Optimisation with a recommendation. */
  readonly recommended: Evaluation;
  /** What-if of the plan in effect against itself: nothing to recommend. */
  readonly unchanged: Evaluation;
}

export async function standbyFixture(): Promise<TwinFixture> {
  const scenario = createNetworkScenario();
  const config = scenario.config;
  let state = step(config, createInitialState(config), scenario.openingCommands).state;
  while (state.tick < FIXTURE_TICK) state = step(config, state).state;
  const snapshot = createSnapshot(config, state);
  const recommended = await optimizeStandby(snapshot, FIXTURE_OPTIONS);
  const unchanged = await compareStandbyPlans(
    snapshot,
    [{ label: "Unchanged", plan: currentPlan(state) }],
    { horizon_ticks: 3_000, max_evaluations: 2 },
  );
  return { snapshot, recommended, unchanged };
}
