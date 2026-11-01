/**
 * The evaluation worker's logic (Phase 6.1): validate a job, check the snapshot it carries, run
 * one trajectory with the real engine and report progress and the result. Pure apart from `post`,
 * so tests run it in-process; `evaluation.worker.ts` wires it to the worker's message port.
 *
 * Bundled into the worker by esbuild: relative imports and package names only.
 */
import {
  checkInvariants,
  stateHash,
  type SimulationConfig,
  type SimulationState,
} from "@warehouse-one/simulation";
import { EvaluationAborted, simulate } from "@warehouse-one/twin";
import { ToWorker, WORKER_LIMITS, type FromWorker } from "./worker-protocol";

export type Post = (message: FromWorker) => void;

/** A handler for messages to the worker. Holds no state across requests but cancellation flags
 * and the hash of the last snapshot it verified (re-verifying the same one is skipped). */
export function createJobHandler(post: Post): (data: unknown) => Promise<void> {
  const running = new Map<string, AbortController>(); // requestId -> abort of its current job
  let verified: string | null = null;

  return async (data) => {
    const parsed = ToWorker.safeParse(data);
    if (!parsed.success) {
      const raw = (data ?? {}) as { requestId?: unknown; jobId?: unknown };
      post({
        type: "failed",
        requestId: typeof raw.requestId === "string" ? raw.requestId.slice(0, 64) : "",
        jobId: typeof raw.jobId === "string" ? raw.jobId.slice(0, 64) : "",
        code: "INVALID_REQUEST",
        message:
          `Rejected a malformed request: ${parsed.error.issues[0]?.path.join(".") || "(root)"} ${parsed.error.issues[0]?.message ?? ""}`.slice(
            0,
            500,
          ),
      });
      return;
    }
    const m = parsed.data;
    if (m.type === "cancel") {
      running.get(m.requestId)?.abort();
      return;
    }
    const { requestId, jobId } = m;
    if (running.has(requestId)) {
      // One job per request at a time: a second start would escape that request's cancel.
      post({
        type: "failed",
        requestId,
        jobId,
        code: "INVALID_REQUEST",
        message: "A job of this request is already running in this worker.",
      });
      return;
    }
    const config = m.snapshot.config as unknown as SimulationConfig;
    const state = m.snapshot.state as unknown as SimulationState;
    if (verified !== m.snapshot.state_hash) {
      // Integrity first: the snapshot must hash to what it claims and satisfy every invariant.
      let problem: string | null = null;
      try {
        if (stateHash(config, state) !== m.snapshot.state_hash)
          problem = "the snapshot does not match its hash";
        else if (checkInvariants(config, state).length > 0)
          problem = "the snapshot violates engine invariants";
      } catch {
        problem = "the snapshot is not a valid simulation state";
      }
      if (problem) {
        post({ type: "failed", requestId, jobId, code: "INVALID_SNAPSHOT", message: problem });
        return;
      }
      verified = m.snapshot.state_hash;
    }
    const ctl = new AbortController();
    running.set(requestId, ctl);
    try {
      const trajectory = await simulate(config, state, m.commands, m.horizon, {
        signal: ctl.signal,
        yieldEvery: WORKER_LIMITS.yieldEvery,
        onTicks: (ticks) => post({ type: "progress", requestId, jobId, ticks }),
      });
      if (ctl.signal.aborted) post({ type: "cancelled", requestId, jobId });
      else
        post({
          type: "completed",
          requestId,
          jobId,
          trajectory: {
            ...trajectory,
            violations: [...trajectory.violations],
            rejections: [...trajectory.rejections],
          },
        });
    } catch (e) {
      if (e instanceof EvaluationAborted) post({ type: "cancelled", requestId, jobId });
      else
        post({
          type: "failed",
          requestId,
          jobId,
          code: "SIMULATION_FAILED",
          // The message only: no stack trace leaves the worker.
          message: (e instanceof Error ? e.message : "the simulation failed").slice(0, 500),
        });
    } finally {
      if (running.get(requestId) === ctl) running.delete(requestId);
    }
  };
}
