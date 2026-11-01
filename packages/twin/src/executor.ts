import type { SetStandbyCommand } from "@warehouse-one/contracts";
import type { SimulationConfig, SimulationState } from "@warehouse-one/simulation";
import { simulate, type Trajectory } from "./metrics";

/**
 * Where trajectories are simulated (Phase 6.1, DEC-042). The optimiser decides *what* to
 * simulate and keeps all bookkeeping; an executor only runs `simulate()` for a batch of plans from
 * the evaluation's frozen start state. Trajectories are independent and `simulate()` is pure, so
 * running a batch in parallel (worker pool) or one after another (inline) gives identical results.
 */
export interface TrajectoryJob {
  /** The `linehaul.set_standby` commands that turn the plan in effect into this plan. */
  readonly commands: readonly SetStandbyCommand[];
  readonly label: string;
}

export interface ExecutionContext {
  readonly config: SimulationConfig;
  readonly state: SimulationState;
  /** The snapshot's hash: lets an isolated executor check what it was given. */
  readonly stateHash: string;
  readonly horizon: number;
  readonly signal: AbortSignal;
  readonly yieldEvery?: number;
  /** Ticks simulated so far by job `index` of the current batch. */
  readonly onTicks: (index: number, ticks: number) => void;
}

export interface TrajectoryExecutor {
  /** "inline": in the caller's thread; "worker": in background workers. Shown to the operator. */
  readonly mode: "inline" | "worker";
  /** Jobs it can usefully run at once; 1 means strictly one after another. */
  readonly parallelism: number;
  /** Simulate every job; results in job order. Rejects with EvaluationAborted when aborted. */
  run(jobs: readonly TrajectoryJob[], ctx: ExecutionContext): Promise<Trajectory[]>;
}

/** Runs jobs one after another in the current thread (tests, CLI, and the explicit fallback). */
export const inlineExecutor: TrajectoryExecutor = {
  mode: "inline",
  parallelism: 1,
  async run(jobs, ctx) {
    const out: Trajectory[] = [];
    for (const [i, job] of jobs.entries())
      out.push(
        await simulate(ctx.config, ctx.state, job.commands, ctx.horizon, {
          signal: ctx.signal,
          yieldEvery: ctx.yieldEvery,
          onTicks: (n) => ctx.onTicks(i, n),
        }),
      );
    return out;
  },
};
