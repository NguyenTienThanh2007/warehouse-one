/**
 * Browser entry of the multi-seed benchmark (twin-robustness-benchmark.ts bundles it with esbuild
 * and injects it into the running app). It drives the production code on a fixed input: the real
 * `evaluateRobustness` / `optimizeStandby` and the real `WorkerPool`, whose workers load the same
 * bundle as the app (/workers/twin-evaluation.js). Each worker is wrapped only to time its jobs.
 */
import {
  evaluateRobustness,
  inlineExecutor,
  optimizeStandby,
  type Evaluation,
} from "../../packages/twin/src/index";
import type { Snapshot } from "../../packages/simulation/src/index";
import { WorkerPool, type WorkerLike } from "../../apps/web/src/lib/twin/worker-pool";
import type { ToWorker } from "../../apps/web/src/lib/twin/worker-protocol";

interface Interval {
  readonly worker: number;
  readonly start: number;
  readonly end: number;
}

/** A real module worker, timing each job from its start message to its final message. */
class TimedWorker implements WorkerLike {
  private readonly w = new Worker("/workers/twin-evaluation.js", { type: "module" });
  private open: number | null = null;
  private handler: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(
    private readonly id: number,
    private readonly intervals: Interval[],
    private readonly startups: number[],
  ) {
    const t0 = performance.now();
    this.w.onmessage = (e: MessageEvent<unknown>) => {
      const type = (e.data as { type?: string } | null)?.type;
      if (type === "ready") this.startups.push(performance.now() - t0);
      if (
        (type === "completed" || type === "cancelled" || type === "failed") &&
        this.open !== null
      ) {
        this.intervals.push({ worker: this.id, start: this.open, end: performance.now() });
        this.open = null;
      }
      this.handler?.(e);
    };
  }
  get onmessage() {
    return this.handler;
  }
  set onmessage(fn: ((event: MessageEvent<unknown>) => void) | null) {
    this.handler = fn;
  }
  get onerror() {
    return this.w.onerror;
  }
  set onerror(fn: ((event: ErrorEvent) => void) | null) {
    this.w.onerror = fn;
  }
  get onmessageerror() {
    return this.w.onmessageerror;
  }
  set onmessageerror(fn: ((event: MessageEvent<unknown>) => void) | null) {
    this.w.onmessageerror = fn;
  }
  postMessage(message: ToWorker): void {
    if (message.type === "start") this.open = performance.now();
    this.w.postMessage(message);
  }
  terminate(): void {
    this.w.terminate();
  }
}

export interface BenchRequest {
  readonly snapshot: Snapshot;
  readonly discovery: Evaluation;
  readonly candidateId: string;
  /** 0: the single-seed optimisation (the discovery's own options) instead of a validation. */
  readonly seeds: number;
  readonly rootSeed: string;
  /** Workers in the pool; 0: the explicit main-thread fallback (400-tick slices). */
  readonly workers: number;
  /** Cancel after this many ms (cancellation latency) instead of running to the end. */
  readonly cancelAfterMs?: number;
}

export interface BenchResult {
  readonly wallMs: number;
  readonly verdict: string | null;
  readonly ticksSimulated: number;
  readonly utilisation: number | null;
  readonly peakConcurrentJobs: number;
  readonly workerStartupMs: readonly number[];
  readonly cancel: { readonly rejectMs: number; readonly quietMs: number } | null;
  readonly resultId: string | null;
}

async function run(r: BenchRequest): Promise<BenchResult> {
  const intervals: Interval[] = [];
  const startups: number[] = [];
  let made = 0;
  const pool =
    r.workers > 0
      ? new WorkerPool(() => new TimedWorker(made++, intervals, startups), { size: r.workers })
      : null;
  const ctl = new AbortController();
  const t0 = performance.now();
  let abortedAt = 0;
  if (r.cancelAfterMs !== undefined)
    setTimeout(() => {
      abortedAt = performance.now();
      ctl.abort();
    }, r.cancelAfterMs);
  const hooks = {
    executor: pool ?? inlineExecutor,
    signal: ctl.signal,
    yieldEvery: pool ? undefined : 400,
    now: () => performance.now(),
  };
  let verdict: string | null = null;
  let ticks = 0;
  let resultId: string | null = null;
  let cancel: BenchResult["cancel"] = null;
  try {
    if (r.seeds === 0) {
      const e = await optimizeStandby(r.snapshot, r.discovery.options, hooks);
      verdict = e.recommendation ? "recommended" : "none";
      ticks = e.runtime.ticks_simulated;
      resultId = e.evaluation_id;
    } else {
      const e = await evaluateRobustness(
        r.snapshot,
        r.discovery,
        r.candidateId,
        { seeds: r.seeds, root_seed: r.rootSeed },
        hooks,
      );
      verdict = e.verdict;
      ticks = e.runtime.ticks_simulated;
      resultId = e.robustness_id;
    }
  } catch (e) {
    if (!ctl.signal.aborted) throw e;
    const rejectMs = performance.now() - abortedAt;
    // Wait for the workers to confirm, then measure when the last one went quiet.
    await new Promise((res) => setTimeout(res, 3_000));
    const last = Math.max(abortedAt, ...intervals.map((i) => i.end));
    cancel = { rejectMs, quietMs: last - abortedAt };
  }
  const wallMs = performance.now() - t0;
  pool?.dispose();
  const busy = intervals.reduce((s, i) => s + (i.end - i.start), 0);
  const events = intervals.flatMap((i) => [
    [i.start, 1],
    [i.end, -1],
  ]) as [number, number][];
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, d] of events) peak = Math.max(peak, (now += d));
  return {
    wallMs,
    verdict,
    ticksSimulated: ticks,
    utilisation: pool && !cancel ? busy / (r.workers * wallMs) : null,
    peakConcurrentJobs: pool ? peak : 1,
    workerStartupMs: startups,
    cancel,
    resultId,
  };
}

(window as unknown as { __twinBench: { run: typeof run } }).__twinBench = { run };
