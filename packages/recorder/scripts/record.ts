/**
 * Record a headless simulation run to the API (the same RunRecorder the web app uses).
 *
 *   pnpm sim:record --api http://localhost:8010 --scenario showcase --ticks 3000
 *   pnpm sim:record --api ... --scenario empty --script operations-demo --ticks 6000
 *
 * Prints one JSON line with the run's simulation_id and what was recorded; exits non-zero when the
 * API rejects data or stays unreachable past the retry budget.
 */
import {
  createScenario,
  isScenarioId,
  OPERATIONS_DEMO_SCRIPT,
  SimulationRunner,
  type LoggedCommand,
} from "@warehouse-one/simulation";
import { RunRecorder, withFreshRunId } from "../src/index";
import { args, required } from "./args";

const a = args();
const api = required(a, "api");
const scenarioId = a.get("scenario") ?? "showcase";
if (!isScenarioId(scenarioId)) {
  console.error(`unknown scenario ${scenarioId}`);
  process.exit(2);
}
const ticks = Number(a.get("ticks") ?? 3000);
const flushEvery = Number(a.get("flush-every") ?? 250);
const script: readonly LoggedCommand[] =
  a.get("script") === "operations-demo" ? OPERATIONS_DEMO_SCRIPT : [];

const scenario = createScenario(scenarioId);
const config = withFreshRunId(scenario.config, a.get("simulation-id"));
const runner = new SimulationRunner(config, { freezeState: false });
const recorder = new RunRecorder({
  apiUrl: api,
  config,
  scenarioId,
  source: "recorder",
  maxEventsPerBatch: Number(a.get("batch") ?? 500),
  retry: { baseMs: 250, maxMs: 8000, maxAttempts: 8 },
});
recorder.attach(runner);

// The opening commands apply at tick 1, as in the web app; script commands at their own ticks.
for (const c of scenario.openingCommands) runner.submit(c);
const byTick = new Map<number, LoggedCommand["command"][]>();
for (const { tick, command } of script) byTick.set(tick, [...(byTick.get(tick) ?? []), command]);

try {
  while (runner.state.tick < ticks) {
    for (const c of byTick.get(runner.state.tick + 1) ?? []) runner.submit(c);
    runner.stepOnce();
    if (runner.state.tick % flushEvery === 0) await recorder.flush();
  }
  await recorder.flush();
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: String(err), status: recorder.status() }));
  process.exit(1);
}
const s = recorder.status();
console.log(
  JSON.stringify({
    ok: true,
    simulation_id: s.simulationId,
    scenario_id: scenarioId,
    events: s.sentEvents,
    commands: s.sentCommands,
    last_sequence: s.lastSequence,
    through_tick: s.throughTick,
  }),
);
