/**
 * A small pool of evaluation workers that runs the twin's trajectories off the main thread
 * (Phase 6.1, DEC-042). It implements the twin's `TrajectoryExecutor`: the optimiser decides what
 * to simulate, the pool only runs `simulate()` jobs, so results are identical to the inline
 * executor (tested). Workers are created lazily up to `size`, reused across requests, replaced
 * after a crash or a stall, and terminated when the pool has been idle for a while.
 */
import {
  EvaluationAborted,
  type ExecutionContext,
  type Trajectory,
  type TrajectoryExecutor,
  type TrajectoryJob,
} from "@warehouse-one/twin";
import { FromWorker, WORKER_LIMITS, type ToWorker } from "./worker-protocol";

/** The part of `Worker` the pool uses (a fake one in tests). */
export interface WorkerLike {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}

export type PoolErrorCode =
  | "WORKER_UNAVAILABLE"
  | "WORKER_CRASHED"
  | "WORKER_TIMEOUT"
  | "RESOURCE_LIMIT"
  | "INVALID_REQUEST"
  | "INVALID_SNAPSHOT"
  | "SIMULATION_FAILED";

export class PoolError extends Error {
  constructor(
    readonly code: PoolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PoolError";
  }
}

export interface PoolOptions {
  readonly size: number;
  /** Requests (batches) allowed at once; more are refused, never queued without bound. */
  readonly maxConcurrentRequests?: number;
  readonly maxJobsPerRequest?: number;
  /** A running job that sends nothing for this long is stopped (its worker is replaced). */
  readonly stallMs?: number;
  /** After a cancel, a worker that has not confirmed within this long is terminated. */
  readonly cancelGraceMs?: number;
  /** Workers are terminated after the pool has been idle this long. */
  readonly idleMs?: number;
  /** A new worker that has not said it is ready within this long counts as unavailable. */
  readonly startMs?: number;
}

interface Slot {
  readonly worker: WorkerLike;
  ready: boolean;
  job: Running | null;
  /** Id of a cancelled job still running in the worker: the slot is busy until that job ends. */
  draining: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Running {
  readonly request: Request;
  readonly index: number;
  readonly jobId: string;
}

interface Request {
  readonly id: string;
  readonly ctx: ExecutionContext;
  readonly jobs: readonly TrajectoryJob[];
  readonly results: (Trajectory | undefined)[];
  next: number;
  remaining: number;
  done: boolean;
  resolve(r: Trajectory[]): void;
  reject(e: Error): void;
}

let seq = 0;
const newId = (p: string) => `${p}${(++seq).toString(36)}`;

export class WorkerPool implements TrajectoryExecutor {
  readonly mode = "worker" as const;
  readonly parallelism: number;
  private readonly slots: Slot[] = [];
  private readonly requests = new Map<string, Request>();
  private readonly o: Required<PoolOptions>;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Workers started (for diagnostics and tests). */
  started = 0;

  constructor(
    private readonly create: () => WorkerLike,
    options: PoolOptions,
  ) {
    this.o = {
      maxConcurrentRequests: 2,
      maxJobsPerRequest: 16,
      stallMs: 30_000,
      cancelGraceMs: 2_000,
      idleMs: 60_000,
      startMs: 15_000,
      ...options,
    };
    this.parallelism = Math.max(1, Math.floor(this.o.size));
  }

  /** Workers alive now. */
  get workers(): number {
    return this.slots.length;
  }

  run(jobs: readonly TrajectoryJob[], ctx: ExecutionContext): Promise<Trajectory[]> {
    if (ctx.signal.aborted) return Promise.reject(new EvaluationAborted());
    if (this.requests.size >= this.o.maxConcurrentRequests)
      return Promise.reject(
        new PoolError(
          "RESOURCE_LIMIT",
          `At most ${this.o.maxConcurrentRequests} evaluations can run at once.`,
        ),
      );
    if (jobs.length > this.o.maxJobsPerRequest || ctx.horizon > WORKER_LIMITS.horizonTicks)
      return Promise.reject(
        new PoolError("RESOURCE_LIMIT", "The request exceeds the evaluation limits."),
      );
    if (jobs.length === 0) return Promise.resolve([]);
    this.clearIdle();
    return new Promise((resolve, reject) => {
      const request: Request = {
        id: newId("r"),
        ctx,
        jobs,
        results: new Array(jobs.length),
        next: 0,
        remaining: jobs.length,
        done: false,
        resolve,
        reject,
      };
      this.requests.set(request.id, request);
      ctx.signal.addEventListener("abort", () => this.cancel(request), { once: true });
      this.dispatch();
    });
  }

  /** Terminate every worker (page unload, tests). Running requests fail. */
  dispose(): void {
    for (const r of [...this.requests.values()])
      this.finish(r, new PoolError("WORKER_UNAVAILABLE", "The evaluation pool was shut down."));
    for (const s of [...this.slots]) this.drop(s);
    this.clearIdle();
  }

  // --- Scheduling ------------------------------------------------------------------------------

  private dispatch(): void {
    for (const request of this.requests.values()) {
      while (!request.done && request.next < request.jobs.length) {
        const slot = this.freeSlot();
        if (!slot) return;
        const index = request.next++;
        const job = request.jobs[index] as TrajectoryJob;
        const running: Running = { request, index, jobId: newId("j") };
        slot.job = running;
        // Until it is ready, a new worker is on the start-up clock; then on the stall clock.
        if (slot.ready) this.watch(slot, this.o.stallMs, () => this.stall(slot));
        slot.worker.postMessage({
          type: "start",
          requestId: request.id,
          jobId: running.jobId,
          snapshot: {
            config: request.ctx.config as unknown as Record<string, unknown>,
            // A job may bring its own start state (one seeded copy per seed, Phase 6.2).
            state: (job.start?.state ?? request.ctx.state) as unknown as Record<string, unknown>,
            state_hash: job.start?.stateHash ?? request.ctx.stateHash,
          },
          horizon: request.ctx.horizon,
          commands: [...job.commands],
        });
      }
    }
    if (this.requests.size === 0) this.scheduleIdle();
  }

  private freeSlot(): Slot | null {
    const free = this.slots.find((s) => !s.job && s.draining === null);
    if (free) return free;
    if (this.slots.length < this.parallelism) return this.spawn();
    return null;
  }

  private spawn(): Slot | null {
    let worker: WorkerLike;
    try {
      worker = this.create();
    } catch {
      this.failAll(
        new PoolError(
          "WORKER_UNAVAILABLE",
          "Background workers cannot be started in this browser.",
        ),
      );
      return null;
    }
    this.started += 1;
    const slot: Slot = { worker, ready: false, job: null, draining: null, timer: null };
    this.slots.push(slot);
    worker.onmessage = (e) => this.onMessage(slot, e.data);
    worker.onerror = () =>
      this.fail(
        slot,
        slot.ready
          ? new PoolError("WORKER_CRASHED", "An evaluation worker crashed.")
          : new PoolError(
              "WORKER_UNAVAILABLE",
              "The evaluation worker could not be loaded (public/workers/twin-evaluation.js).",
            ),
      );
    worker.onmessageerror = () =>
      this.fail(slot, new PoolError("WORKER_CRASHED", "A worker message could not be read."));
    this.watch(slot, this.o.startMs, () =>
      this.fail(
        slot,
        new PoolError("WORKER_UNAVAILABLE", "The evaluation worker did not start in time."),
      ),
    );
    return slot;
  }

  // --- Messages from workers ---------------------------------------------------------------

  private onMessage(slot: Slot, data: unknown): void {
    const parsed = FromWorker.safeParse(data);
    if (!parsed.success) {
      this.fail(slot, new PoolError("WORKER_CRASHED", "A worker sent an invalid message."));
      return;
    }
    const m = parsed.data;
    if (m.type === "ready") {
      slot.ready = true;
      if (!slot.job) this.unwatch(slot);
      else this.watch(slot, this.o.stallMs, () => this.stall(slot));
      return;
    }
    const job = slot.job;
    // A message for anything but the job this worker runs now is late or duplicated: drop it.
    if (!job || job.jobId !== m.jobId || job.request.id !== m.requestId) {
      if (
        slot.draining === m.jobId &&
        (m.type === "cancelled" || m.type === "completed" || m.type === "failed")
      ) {
        // The cancelled job has stopped: the worker can take queued work again.
        this.release(slot);
        this.dispatch();
      }
      return;
    }
    const r = job.request;
    switch (m.type) {
      case "progress":
        this.watch(slot, this.o.stallMs, () => this.stall(slot));
        if (!r.done) r.ctx.onTicks(job.index, m.ticks);
        return;
      case "completed":
        this.release(slot);
        if (r.done) return;
        r.results[job.index] = m.trajectory as Trajectory;
        r.remaining -= 1;
        if (r.remaining === 0) this.finish(r, null);
        this.dispatch();
        return;
      case "cancelled":
        this.release(slot);
        this.dispatch();
        return;
      case "failed":
        this.release(slot);
        this.finish(r, new PoolError(m.code, m.message));
        this.dispatch();
        return;
    }
  }

  // --- Ending requests and workers -------------------------------------------------------------

  /** Cancel a request: queued jobs never start, running ones are asked to stop. */
  private cancel(request: Request): void {
    if (request.done) return;
    this.finish(request, new EvaluationAborted());
  }

  private finish(request: Request, error: Error | null): void {
    if (request.done) return;
    request.done = true;
    this.requests.delete(request.id);
    for (const slot of this.slots) {
      if (slot.job?.request !== request) continue;
      // Stop the rest of this request's work; other requests' jobs are untouched.
      slot.draining = slot.job.jobId;
      slot.job = null;
      slot.worker.postMessage({ type: "cancel", requestId: request.id });
      this.watch(slot, this.o.cancelGraceMs, () => {
        // It did not stop in time: replace it, and give its place to queued work.
        this.drop(slot);
        this.dispatch();
      });
    }
    if (error) request.reject(error);
    else request.resolve(request.results as Trajectory[]);
    this.dispatch();
  }

  private failAll(error: Error): void {
    for (const r of [...this.requests.values()]) this.finish(r, error);
  }

  private stall(slot: Slot): void {
    this.fail(
      slot,
      new PoolError("WORKER_TIMEOUT", "An evaluation worker stopped responding and was replaced."),
    );
  }

  /** A worker failed: its job's request fails, the worker is replaced. */
  private fail(slot: Slot, error: PoolError): void {
    const job = slot.job;
    this.drop(slot);
    if (job) this.finish(job.request, error);
    // A worker that cannot load will not load for the next request either: fail them all
    // rather than spawning replacements in a loop.
    if (error.code === "WORKER_UNAVAILABLE") this.failAll(error);
    this.dispatch();
  }

  private release(slot: Slot): void {
    slot.job = null;
    slot.draining = null;
    this.unwatch(slot);
  }

  private drop(slot: Slot): void {
    this.unwatch(slot);
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.onmessageerror = null;
    slot.worker.terminate();
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots.splice(i, 1);
  }

  private watch(slot: Slot, ms: number, onTimeout: () => void): void {
    this.unwatch(slot);
    slot.timer = setTimeout(onTimeout, ms);
  }

  private unwatch(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
  }

  private scheduleIdle(): void {
    if (this.idleTimer || this.slots.length === 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.requests.size > 0) return;
      for (const s of [...this.slots]) if (!s.job && s.draining === null) this.drop(s);
    }, this.o.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
