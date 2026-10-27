import {
  compareStandbyPlans,
  optimizeStandby,
  TwinError,
  type Evaluation,
  type EvaluateHooks,
  type Progress,
  type TwinErrorCode,
} from "@warehouse-one/twin";
import type { EvaluationRequest } from "./protocol";

export class EvaluationFailed extends Error {
  constructor(
    readonly code: TwinErrorCode | "EVALUATION_FAILED",
    message: string,
  ) {
    super(message);
  }
}

/** Run one request in the current thread (the worker's body, and the fallback without workers). */
export function evaluate(request: EvaluationRequest, hooks: EvaluateHooks): Promise<Evaluation> {
  return request.kind === "optimize"
    ? optimizeStandby(request.snapshot, request.options, hooks)
    : compareStandbyPlans(request.snapshot, request.alternatives, request.options, hooks);
}

export function toFailure(e: unknown): EvaluationFailed {
  if (e instanceof EvaluationFailed) return e;
  if (e instanceof TwinError) return new EvaluationFailed(e.code, e.message);
  return new EvaluationFailed(
    "EVALUATION_FAILED",
    e instanceof Error ? e.message : "The evaluation failed.",
  );
}

/** Ticks per slice of work before the evaluation yields to the page (about 35 ms each). */
const SLICE_TICKS = 400;

/**
 * Evaluate in the page, in slices that yield to the event loop so the live simulation and the UI
 * keep running. Isolation does not depend on a thread: the input is a frozen snapshot and the
 * engine never mutates its input, so nothing an evaluation does can reach the live run.
 * (A module worker would also free the main thread, but Next 16.3's Turbopack copies
 * `new Worker(new URL(...))` targets as raw files instead of bundling them.)
 */
export function runEvaluation(
  request: EvaluationRequest,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<Evaluation> {
  return evaluate(request, {
    onProgress,
    signal,
    now: () => performance.now(),
    yieldEvery: SLICE_TICKS,
  }).catch((e: unknown) => {
    throw toFailure(e);
  });
}
