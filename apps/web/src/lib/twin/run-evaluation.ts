import {
  compareStandbyPlans,
  inlineExecutor,
  optimizeStandby,
  TwinError,
  type Evaluation,
  type EvaluateHooks,
  type Progress,
  type TwinErrorCode,
} from "@warehouse-one/twin";
import type { EvaluationRequest } from "./protocol";
import { PoolError, WorkerPool, type PoolErrorCode } from "./worker-pool";

export type EvaluationErrorCode = TwinErrorCode | PoolErrorCode | "EVALUATION_FAILED";

export class EvaluationFailed extends Error {
  constructor(
    readonly code: EvaluationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Run one request with the given hooks (executor included). */
export function evaluate(request: EvaluationRequest, hooks: EvaluateHooks): Promise<Evaluation> {
  return request.kind === "optimize"
    ? optimizeStandby(request.snapshot, request.options, hooks)
    : compareStandbyPlans(request.snapshot, request.alternatives, request.options, hooks);
}

export function toFailure(e: unknown): EvaluationFailed {
  if (e instanceof EvaluationFailed) return e;
  if (e instanceof TwinError || e instanceof PoolError)
    return new EvaluationFailed(e.code, e.message);
  return new EvaluationFailed(
    "EVALUATION_FAILED",
    e instanceof Error ? e.message : "The evaluation failed.",
  );
}

/** Where an evaluation ran, shown with its result. */
export type ExecutionMode = "worker" | "main_thread";

export interface EvaluationRun {
  readonly evaluation: Evaluation;
  readonly mode: ExecutionMode;
  /** Background workers used (0 on the main thread). */
  readonly workers: number;
  /** Wall-clock duration of the whole evaluation. */
  readonly elapsedMs: number;
}

/** The worker bundle (scripts/build-twin-worker.mjs), served from public/. */
export const WORKER_URL = "/workers/twin-evaluation.js";

/** Workers in the pool: one core stays for the page and the live run; never more than 4. */
export function poolSize(cores = globalThis.navigator?.hardwareConcurrency ?? 2): number {
  return Math.max(1, Math.min(4, cores - 1));
}

let pool: WorkerPool | null = null;

function workerPool(): WorkerPool {
  pool ??= new WorkerPool(() => new Worker(WORKER_URL, { type: "module" }), { size: poolSize() });
  return pool;
}

/** Terminate the evaluation workers (they are also stopped after a minute of idleness). */
export function disposeWorkers(): void {
  pool?.dispose();
  pool = null;
}

/** Ticks per slice when an evaluation runs on the main thread (about 35 ms each). */
const SLICE_TICKS = 400;

/**
 * Evaluate a request. "worker" runs the trajectories on a pool of background workers (the page and
 * the live simulation keep their thread); "main_thread" runs them in the page in short slices, as
 * an explicit fallback when workers are not available. The result is identical either way; the
 * mode is reported with it.
 */
export async function runEvaluation(
  request: EvaluationRequest,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
  mode: ExecutionMode = "worker",
): Promise<EvaluationRun> {
  if (mode === "worker" && typeof Worker === "undefined")
    throw new EvaluationFailed("WORKER_UNAVAILABLE", "This browser cannot run background workers.");
  const executor = mode === "worker" ? workerPool() : inlineExecutor;
  const started = performance.now();
  try {
    const evaluation = await evaluate(request, {
      onProgress,
      signal,
      now: () => performance.now(),
      executor,
      yieldEvery: mode === "worker" ? undefined : SLICE_TICKS,
    });
    return {
      evaluation,
      mode,
      workers: mode === "worker" ? executor.parallelism : 0,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    throw toFailure(e);
  }
}
