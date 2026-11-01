import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { seedRng, stateHash, type Snapshot } from "@warehouse-one/simulation";
import {
  currentPlan,
  evaluateRobustness,
  EvaluationAborted,
  optimizeStandby,
  planCommands,
  simulate,
  type Evaluation,
  type ExecutionContext,
  type TrajectoryJob,
} from "@warehouse-one/twin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobHandler } from "./worker-core";
import { FromWorker, type ToWorker } from "./worker-protocol";
import { PoolError, WorkerPool, type WorkerLike } from "./worker-pool";

const dir = resolve(__dirname, "../../../../../data/fixtures/twin-standby");
const snapshot = JSON.parse(readFileSync(resolve(dir, "snapshot.json"), "utf8")) as Snapshot;
const golden = JSON.parse(
  readFileSync(resolve(dir, "evaluation-recommended.json"), "utf8"),
) as Evaluation;
// The golden fixture's options (packages/twin/src/fixture.ts).
const FIXTURE_OPTIONS = { horizon_ticks: 9_000, max_evaluations: 6 };
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const withoutRuntime = (e: Evaluation) => json({ ...e, runtime: null });

function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

// Node has no ErrorEvent; the pool only needs the call.
const errorEvent = () => new Event("error") as ErrorEvent;

type Behaviour =
  | "real"
  | "ignore-cancel"
  | "crash-on-start"
  | "never-ready"
  | "fail-to-load"
  | "silent"
  | "rogue"
  | "garbled";

/** A worker running the real worker core in this thread, with copies of every message (as
 * postMessage would), or a misbehaving one. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  terminated = false;
  readonly received: ToWorker[] = [];
  private readonly handle = createJobHandler((m) => this.emit(m));

  constructor(private readonly behaviour: Behaviour = "real") {
    // A real worker announces itself before it can handle any message.
    setTimeout(() => {
      if (behaviour === "fail-to-load") this.onerror?.(errorEvent());
      else if (behaviour !== "never-ready")
        this.onmessage?.(new MessageEvent("message", { data: { type: "ready" } }));
    }, 0);
  }

  postMessage(message: ToWorker): void {
    if (this.terminated) return;
    this.received.push(message);
    const copy = structuredClone(message);
    setTimeout(() => {
      if (this.terminated) return;
      if (this.behaviour === "crash-on-start" && copy.type === "start")
        this.onerror?.(errorEvent());
      else if (this.behaviour === "rogue" && copy.type === "start")
        this.onmessage?.(new MessageEvent("message", { data: { type: "completed", hacked: 1 } }));
      else if (this.behaviour === "garbled" && copy.type === "start")
        this.onmessageerror?.(new MessageEvent("messageerror"));
      else if (this.behaviour === "ignore-cancel" && copy.type === "cancel") return;
      else if (this.behaviour !== "silent") void this.handle(copy);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(m: unknown): void {
    if (this.terminated) return;
    const copy = structuredClone(m);
    setTimeout(
      () => !this.terminated && this.onmessage?.(new MessageEvent("message", { data: copy })),
      0,
    );
  }
}

const pools: WorkerPool[] = [];
function pool(
  size: number,
  behaviours: Behaviour[] = [],
  extra: Partial<ConstructorParameters<typeof WorkerPool>[1]> = {},
) {
  const workers: FakeWorker[] = [];
  const p = new WorkerPool(
    () => {
      const w = new FakeWorker(behaviours[workers.length] ?? "real");
      workers.push(w);
      return w;
    },
    { size, ...extra },
  );
  pools.push(p);
  return { p, workers };
}
afterEach(() => {
  for (const p of pools.splice(0)) p.dispose();
  vi.useRealTimers();
});

const base = currentPlan(snapshot.state);
const ctx = (signal: AbortSignal, onTicks = () => {}): ExecutionContext => ({
  config: snapshot.config,
  state: snapshot.state,
  stateHash: snapshot.state_hash,
  horizon: 2_000,
  signal,
  onTicks,
});
const job = (site: string | null, n: number): TrajectoryJob => ({
  label: `job ${n}`,
  commands: planCommands(
    base,
    {
      assignments: base.assignments.map((a, i) => (i === 0 ? { ...a, site_id: site } : a)),
    },
    `t-${n}`,
  ),
});

describe("worker core (the real engine inside the worker)", () => {
  it("runs a trajectory identical to simulate(), reporting progress, with valid messages", async () => {
    const posted: unknown[] = [];
    const handle = createJobHandler((m) => posted.push(m));
    const j = job("harbour-terminal", 1);
    await handle({
      type: "start",
      requestId: "r1",
      jobId: "j1",
      snapshot: { config: snapshot.config, state: snapshot.state, state_hash: snapshot.state_hash },
      horizon: 3_000,
      commands: j.commands,
    });
    for (const m of posted) expect(FromWorker.safeParse(m).success).toBe(true);
    const done = posted.at(-1) as { type: string; trajectory: unknown };
    expect(done.type).toBe("completed");
    const direct = await simulate(snapshot.config, snapshot.state, j.commands, 3_000);
    expect(json(done.trajectory)).toEqual(json(direct));
    // One per 1,000-tick slice, the last one at the end of the horizon.
    expect(
      posted
        .filter((m) => (m as { type: string }).type === "progress")
        .map((m) => (m as { ticks: number }).ticks),
    ).toEqual([1000, 2000, 3000, 3000]);
  });

  it("refuses malformed requests and tampered snapshots without running anything", async () => {
    const posted: { type: string; code?: string }[] = [];
    const handle = createJobHandler((m) => posted.push(m));
    await handle({ type: "start", requestId: "r1" });
    await handle({
      type: "start",
      requestId: "r2",
      jobId: "j2",
      snapshot: { config: snapshot.config, state: snapshot.state, state_hash: "0".repeat(32) },
      horizon: 100,
      commands: [],
    });
    await handle({
      type: "start",
      requestId: "r3",
      jobId: "j3",
      snapshot: { config: snapshot.config, state: snapshot.state, state_hash: snapshot.state_hash },
      horizon: 99_999,
      commands: [],
    });
    expect(posted.map((m) => m.code)).toEqual([
      "INVALID_REQUEST",
      "INVALID_SNAPSHOT",
      "INVALID_REQUEST",
    ]);
  });

  it("refuses a second job under a request id that is already running", async () => {
    const posted: { type: string; jobId?: string; code?: string }[] = [];
    const handle = createJobHandler((m) => posted.push(m));
    const start = (jobId: string) => ({
      type: "start",
      requestId: "r1",
      jobId,
      snapshot: { config: snapshot.config, state: snapshot.state, state_hash: snapshot.state_hash },
      horizon: 30_000,
      commands: [],
    });
    const first = handle(start("j1"));
    await new Promise((r) => setTimeout(r, 5));
    await handle(start("j2"));
    expect(posted.find((m) => m.jobId === "j2")).toMatchObject({
      type: "failed",
      code: "INVALID_REQUEST",
    });
    // The cancel still reaches the job that runs.
    await handle({ type: "cancel", requestId: "r1" });
    await first;
    expect(posted.at(-1)).toMatchObject({ type: "cancelled", jobId: "j1" });
  });

  it("stops a job when its request is cancelled", async () => {
    const posted: { type: string }[] = [];
    const handle = createJobHandler((m) => posted.push(m));
    const run = handle({
      type: "start",
      requestId: "r1",
      jobId: "j1",
      snapshot: { config: snapshot.config, state: snapshot.state, state_hash: snapshot.state_hash },
      horizon: 30_000,
      commands: [],
    });
    await new Promise((r) => setTimeout(r, 5));
    await handle({ type: "cancel", requestId: "r1" });
    await run;
    expect(posted.at(-1)?.type).toBe("cancelled");
    expect(posted.filter((m) => m.type === "progress").length).toBeLessThan(30);
  });
});

describe("worker pool", () => {
  it("runs the real optimiser with results identical to the inline evaluator", async () => {
    const { p, workers } = pool(3);
    const frozen = freeze(structuredClone(snapshot));
    const e = await optimizeStandby(frozen, FIXTURE_OPTIONS, { executor: p });
    expect(withoutRuntime(e)).toEqual(withoutRuntime(golden));
    expect(e.evaluation_id).toBe(golden.evaluation_id);
    expect(workers.length).toBeLessThanOrEqual(3);
    expect(stateHash(frozen.config, frozen.state)).toBe(snapshot.state_hash);
  }, 120_000);

  it("keeps concurrent requests apart and limits how many run at once", async () => {
    const { p } = pool(2, [], { maxConcurrentRequests: 2 });
    const a = new AbortController();
    const b = new AbortController();
    const ja = [job("harbour-terminal", 1), job("riverside-xd", 2)];
    const jb = [job(null, 3), job("northgate-dc", 4)];
    const runA = p.run(ja, ctx(a.signal));
    const runB = p.run(jb, ctx(b.signal));
    await expect(p.run([job(null, 5)], ctx(new AbortController().signal))).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
    });
    const [ra, rb] = await Promise.all([runA, runB]);
    for (const [k, j] of [...ja, ...jb].entries()) {
      const direct = await simulate(snapshot.config, snapshot.state, j.commands, 2_000);
      expect(json((k < 2 ? ra : rb)[k % 2])).toEqual(json(direct));
    }
  }, 60_000);

  it("cancelling one request leaves the other requests on the pool untouched", async () => {
    const { p, workers } = pool(2);
    const a = new AbortController();
    const b = new AbortController();
    // A holds one worker with a long job; B runs on the other and queues its second job.
    const runA = p.run([job(null, 1)], { ...ctx(a.signal), horizon: 30_000 });
    const jb = [job("harbour-terminal", 2), job("riverside-xd", 3), job("northgate-dc", 4)];
    const runB = p.run(jb, ctx(b.signal));
    await new Promise((r) => setTimeout(r, 20));
    a.abort();
    await expect(runA).rejects.toBeInstanceOf(EvaluationAborted);
    const rb = await runB;
    for (const [k, j] of jb.entries()) {
      const direct = await simulate(snapshot.config, snapshot.state, j.commands, 2_000);
      expect(json(rb[k])).toEqual(json(direct));
    }
    const received = workers.flatMap((w) => w.received);
    const starts = received.filter((m) => m.type === "start");
    // A was dispatched first; every cancel names A, none names B.
    const idA = starts[0]?.requestId;
    const cancels = received.filter((m) => m.type === "cancel").map((m) => m.requestId);
    expect(cancels.length).toBeGreaterThan(0);
    expect(new Set(cancels)).toEqual(new Set([idA]));
    // Every job of both requests ran under its own ids.
    expect(new Set(starts.map((m) => m.jobId)).size).toBe(starts.length);
    expect(new Set(starts.map((m) => m.requestId)).size).toBe(2);
  }, 60_000);

  it("cancelling a queued request never starts it and leaves the running one alone", async () => {
    const { p, workers } = pool(1);
    const b = new AbortController();
    const runA = p.run([job("harbour-terminal", 1)], {
      ...ctx(new AbortController().signal),
      horizon: 3_000,
    });
    const runB = p.run([job(null, 2)], ctx(b.signal));
    b.abort();
    await expect(runB).rejects.toBeInstanceOf(EvaluationAborted);
    const [t] = await runA;
    const direct = await simulate(
      snapshot.config,
      snapshot.state,
      job("harbour-terminal", 1).commands,
      3_000,
    );
    expect(json(t)).toEqual(json(direct));
    const received = (workers[0] as FakeWorker).received;
    expect(received.filter((m) => m.type === "start")).toHaveLength(1);
    expect(received.some((m) => m.type === "cancel")).toBe(false);
  }, 60_000);

  it("a stalled or garbled worker fails only its own request and is replaced", async () => {
    const { p, workers } = pool(2, ["silent", "real", "garbled"], { stallMs: 500 });
    const stalled = p.run([job(null, 1)], ctx(new AbortController().signal));
    const healthy = p.run([job("riverside-xd", 2)], ctx(new AbortController().signal));
    await expect(stalled).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
    await expect(healthy).resolves.toHaveLength(1);
    expect(workers[0]?.terminated).toBe(true);
    // The replacement (third worker) delivers an unreadable message: a crash, not a result.
    const a = p.run([job(null, 3)], ctx(new AbortController().signal));
    const c = p.run([job(null, 4)], ctx(new AbortController().signal));
    const settled = await Promise.allSettled([a, c]);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(settled.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "WORKER_CRASHED" },
    });
    expect(p.started).toBe(3);
  }, 60_000);

  it("cancels at once, stops the workers' jobs, and serves the next request", async () => {
    const { p, workers } = pool(2);
    const ctl = new AbortController();
    const running = p.run([job(null, 1), job("harbour-terminal", 2), job("riverside-xd", 3)], {
      ...ctx(ctl.signal),
      horizon: 30_000,
    });
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await expect(running).rejects.toBeInstanceOf(EvaluationAborted);
    expect(workers.flatMap((w) => w.received).some((m) => m.type === "cancel")).toBe(true);
    // The third job was never started.
    expect(workers.flatMap((w) => w.received).filter((m) => m.type === "start")).toHaveLength(2);
    const next = await p.run([job(null, 4)], ctx(new AbortController().signal));
    expect(next).toHaveLength(1);
  }, 60_000);

  it("replaces a worker that ignores a cancel, then serves queued work (regression)", async () => {
    // Regression: a slot freed after a cancel did not dispatch the queued request, which then
    // waited forever.
    const { p, workers } = pool(1, ["ignore-cancel", "real"], { cancelGraceMs: 30 });
    const ctl = new AbortController();
    const first = p.run([job(null, 1)], { ...ctx(ctl.signal), horizon: 30_000 });
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    await expect(first).rejects.toBeInstanceOf(EvaluationAborted);
    await expect(p.run([job(null, 2)], ctx(new AbortController().signal))).resolves.toHaveLength(1);
    expect(workers[0]?.terminated).toBe(true);
    expect(workers).toHaveLength(2);
  }, 60_000);

  it("a crashed worker fails only its own request; the pool recovers", async () => {
    const { p, workers } = pool(2, ["crash-on-start", "real"]);
    const crashed = p.run([job(null, 1)], ctx(new AbortController().signal));
    const healthy = p.run([job("riverside-xd", 2)], ctx(new AbortController().signal));
    await expect(crashed).rejects.toMatchObject({ code: "WORKER_CRASHED" });
    const [t] = await healthy;
    const direct = await simulate(
      snapshot.config,
      snapshot.state,
      job("riverside-xd", 2).commands,
      2_000,
    );
    expect(json(t)).toEqual(json(direct));
    expect(workers[0]?.terminated).toBe(true);
    // A replacement worker serves the next request.
    await expect(p.run([job(null, 3)], ctx(new AbortController().signal))).resolves.toHaveLength(1);
  }, 60_000);

  it("reports a worker that cannot load, or never starts, as unavailable", async () => {
    const a = pool(1, ["fail-to-load"]);
    await expect(a.p.run([job(null, 1)], ctx(new AbortController().signal))).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });
    const b = pool(1, ["never-ready"], { startMs: 30 });
    await expect(b.p.run([job(null, 1)], ctx(new AbortController().signal))).rejects.toMatchObject({
      code: "WORKER_UNAVAILABLE",
    });
  });

  it("replaces a worker that stops responding", async () => {
    const { p, workers } = pool(1, ["silent"], { stallMs: 40 });
    await expect(p.run([job(null, 1)], ctx(new AbortController().signal))).rejects.toMatchObject({
      code: "WORKER_TIMEOUT",
    });
    expect(workers[0]?.terminated).toBe(true);
  });

  it("treats an invalid worker message as a crash, never as a result", async () => {
    const { p } = pool(1, ["rogue"]);
    await expect(p.run([job(null, 1)], ctx(new AbortController().signal))).rejects.toBeInstanceOf(
      PoolError,
    );
  });

  it("ignores late and duplicated messages", async () => {
    const { p, workers } = pool(1);
    const ctl = new AbortController();
    const first = p.run([job(null, 1)], { ...ctx(ctl.signal), horizon: 30_000 });
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    await expect(first).rejects.toBeInstanceOf(EvaluationAborted);
    const w = workers[0] as FakeWorker;
    // A stale completion for the cancelled request arrives after the next one started.
    const second = p.run([job("harbour-terminal", 2)], ctx(new AbortController().signal));
    const start = w.received.find((m) => m.type === "start" && m.jobId !== undefined) as Extract<
      ToWorker,
      { type: "start" }
    >;
    w.onmessage?.(
      new MessageEvent("message", {
        data: {
          type: "completed",
          requestId: start.requestId,
          jobId: start.jobId,
          trajectory: {
            metrics: {},
            violations: [],
            rejections: [],
            end_tick: 0,
            end_state_hash: "x",
          },
        },
      }),
    );
    const [t] = await second;
    const direct = await simulate(
      snapshot.config,
      snapshot.state,
      job("harbour-terminal", 2).commands,
      2_000,
    );
    expect(json(t)).toEqual(json(direct));
  }, 60_000);

  it("terminates idle workers and refuses oversized requests", async () => {
    const { p, workers } = pool(2, [], { idleMs: 20 });
    await p.run([job(null, 1)], ctx(new AbortController().signal));
    await new Promise((r) => setTimeout(r, 60));
    expect(p.workers).toBe(0);
    expect(workers.every((w) => w.terminated)).toBe(true);
    const many = Array.from({ length: 17 }, (_, i) => job(null, i));
    await expect(p.run(many, ctx(new AbortController().signal))).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
    });
    await expect(
      p.run([job(null, 1)], { ...ctx(new AbortController().signal), horizon: 40_000 }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  });
});

describe("multi-seed jobs on the pool (Phase 6.2)", () => {
  it("runs each job from its own start state, checked by the worker", async () => {
    const { p, workers } = pool(2);
    const seeded = [1, 2, 3].map((i) => {
      const state = { ...snapshot.state, rng: seedRng(`twin-robustness:t:${i}`) };
      return { state, stateHash: stateHash(snapshot.config, state) };
    });
    const out = await p.run(
      seeded.map((start, i) => ({ ...job(null, i), start })),
      ctx(new AbortController().signal),
    );
    for (const [i, start] of seeded.entries()) {
      const direct = await simulate(snapshot.config, start.state, job(null, i).commands, 2_000);
      expect(json(out[i])).toEqual(json(direct));
    }
    // Each start message carried that job's state and hash, never the context's.
    const starts = workers.flatMap((w) => w.received).filter((m) => m.type === "start");
    expect(starts.map((m) => m.snapshot.state_hash).sort()).toEqual(
      seeded.map((s) => s.stateHash).sort(),
    );
    // A start state whose hash does not match is refused by the worker, not simulated.
    const forged = { state: seeded[0]?.state ?? snapshot.state, stateHash: "0".repeat(32) };
    await expect(
      p.run([{ ...job(null, 9), start: forged }], ctx(new AbortController().signal)),
    ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT" });
  }, 60_000);

  it("a multi-seed evaluation on workers equals the inline one, whatever finishes first", async () => {
    const discovery = await optimizeStandby(snapshot, { horizon_ticks: 3_000, max_evaluations: 3 });
    const id = discovery.candidates.find((c) => c.feasible && c.metrics)?.candidate_id ?? "c1";
    const inline = await evaluateRobustness(snapshot, discovery, id, { seeds: 3, root_seed: "w" });
    const { p } = pool(3);
    const onWorkers = await evaluateRobustness(
      freeze(structuredClone(snapshot)),
      discovery,
      id,
      { seeds: 3, root_seed: "w" },
      { executor: p },
    );
    expect(json({ ...onWorkers, runtime: null })).toEqual(json({ ...inline, runtime: null }));
  }, 120_000);

  it("cancelling a multi-seed evaluation stops it and leaves another request on the pool alone", async () => {
    const discovery = await optimizeStandby(snapshot, { horizon_ticks: 3_000, max_evaluations: 3 });
    const id = discovery.candidates.find((c) => c.feasible && c.metrics)?.candidate_id ?? "c1";
    const { p } = pool(2);
    const ctl = new AbortController();
    const validation = evaluateRobustness(
      snapshot,
      discovery,
      id,
      { seeds: 10, root_seed: "w" },
      { executor: p, signal: ctl.signal },
    );
    const other = p.run([job("harbour-terminal", 1)], ctx(new AbortController().signal));
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await expect(validation).rejects.toMatchObject({ code: "CANCELLED" });
    const [t] = await other;
    const direct = await simulate(
      snapshot.config,
      snapshot.state,
      job("harbour-terminal", 1).commands,
      2_000,
    );
    expect(json(t)).toEqual(json(direct));
  }, 120_000);
});
