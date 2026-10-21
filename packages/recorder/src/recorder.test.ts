import {
  createScenario,
  OPERATIONS_DEMO_SCRIPT,
  SimulationRunner,
  type LoggedCommand,
} from "@warehouse-one/simulation";
import { describe, expect, it } from "vitest";
import { RunRecorder, withFreshRunId } from "./index";

interface Call {
  method: string;
  url: string;
  body: {
    batch_id?: string;
    through_tick?: number;
    commands?: LoggedCommand[];
    events?: { sequence: number; simulation_time_ms: number }[];
  };
}

/** A fake API that records calls and answers with scripted statuses (default 201). */
function fakeApi(statuses: number[] = []) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const status = statuses.shift() ?? 201;
    if (status === 0) throw new TypeError("fetch failed");
    return new Response(
      JSON.stringify(status >= 400 ? { error: { code: "SEQUENCE_GAP", message: "gap" } } : {}),
      { status },
    );
  }) as unknown as typeof fetch;
  return { calls, fn };
}

const empty = createScenario("empty");

function recordDemo(api: ReturnType<typeof fakeApi>, maxEventsPerBatch = 25) {
  const config = withFreshRunId(empty.config, "6f1d4a8e-1c2b-4d3e-9f00-0123456789ab");
  const runner = new SimulationRunner(config);
  let n = 0;
  const recorder = new RunRecorder({
    apiUrl: "http://api.test/",
    config,
    scenarioId: "empty",
    source: "recorder",
    maxEventsPerBatch,
    fetch: api.fn,
    newBatchId: () => `batch-${++n}`,
    sleep: async () => {},
    retry: { baseMs: 1, maxMs: 4, maxAttempts: 4 },
  });
  recorder.attach(runner);
  for (const { tick, command } of OPERATIONS_DEMO_SCRIPT) {
    while (runner.state.tick < tick - 1) runner.stepOnce();
    runner.submit(command);
  }
  while (runner.state.tick < 400) runner.stepOnce();
  return { runner, recorder };
}

describe("RunRecorder", () => {
  it("registers once, then sends every event in order with each tick's commands", async () => {
    const api = fakeApi();
    const { runner, recorder } = recordDemo(api);
    await recorder.flush();
    const [register, ...batches] = api.calls;
    expect(register?.method).toBe("PUT");
    expect(register?.url).toBe(`http://api.test/api/v1/simulations/${recorder.simulationId}`);
    const events = batches.flatMap((b) => b.body.events ?? []);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(batches.every((b) => (b.body.events?.length ?? 0) <= 25)).toBe(true);
    // Every command is sent exactly once, in log order, no later than the first batch reaching it.
    const sent = batches.flatMap((b) => (b.body.commands ?? []).map((c) => ({ c, b })));
    expect(sent.map((s) => s.c.command.command_id)).toEqual(
      runner.commandLog.map((c) => c.command.command_id),
    );
    let closed = 0;
    for (const b of batches) {
      for (const c of b.body.commands ?? []) expect(c.tick).toBeGreaterThan(closed);
      for (const e of b.body.events ?? [])
        expect(e.simulation_time_ms / 100).toBeLessThanOrEqual(b.body.through_tick!);
      closed = b.body.through_tick!;
    }
    expect(closed).toBe(runner.state.tick);
    expect(recorder.status()).toMatchObject({ state: "idle", pendingEvents: 0 });
  });

  it("retries a failed batch with the same batch_id, and stores it once", async () => {
    // register ok, then the first batch fails twice (network, 503) before succeeding.
    const api = fakeApi([201, 0, 503, 201]);
    const { recorder } = recordDemo(api);
    await recorder.flush();
    const firstBatch = api.calls.filter((c) => c.method === "POST").slice(0, 3);
    expect(new Set(firstBatch.map((c) => c.body.batch_id))).toEqual(new Set(["batch-1"]));
    expect(recorder.status().state).toBe("idle");
  });

  it("stops on a rejection (4xx) instead of retrying, and reports why", async () => {
    const api = fakeApi([201, 409]);
    const { recorder } = recordDemo(api);
    await expect(recorder.flush()).rejects.toThrow("SEQUENCE_GAP");
    expect(recorder.status()).toMatchObject({
      state: "failed",
      lastError: { code: "SEQUENCE_GAP", status: 409 },
    });
    expect(api.calls).toHaveLength(2);
    await expect(recorder.flush()).rejects.toThrow("SEQUENCE_GAP");
    expect(api.calls).toHaveLength(2);
  });

  it("gives up after the bounded retry budget", async () => {
    const api = fakeApi([201, 503, 503, 503, 503]);
    const { recorder } = recordDemo(api);
    await expect(recorder.flush()).rejects.toThrow();
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(4);
    expect(recorder.status().state).toBe("failed");
  });

  it("refuses to follow a runner of another run", () => {
    const recorder = new RunRecorder({
      apiUrl: "x",
      config: withFreshRunId(empty.config),
      source: "web",
    });
    expect(() => recorder.attach(new SimulationRunner(empty.config))).toThrow();
  });
});
