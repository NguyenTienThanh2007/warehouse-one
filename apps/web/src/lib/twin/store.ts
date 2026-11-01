"use client";

import { createSnapshot, type Snapshot } from "@warehouse-one/simulation";
import {
  assignCounts,
  currentPlan,
  liveContext,
  SEED_TIERS,
  type Evaluation,
  type Progress,
  type RobustnessEvaluation,
  type RobustnessProgress,
} from "@warehouse-one/twin";
import { create } from "zustand";
import { ApiRequestError, type ApiFailure } from "../api/request";
import { commandOutcomes, useSimulation } from "../sim/store";
import {
  twinApi,
  type Capabilities,
  type Explanation,
  type ProposalDetail,
  type ProposalSummary,
} from "./api";
import type { EvaluationRequest } from "./protocol";
import {
  EvaluationFailed,
  runEvaluation,
  runRobustness,
  type ExecutionMode,
} from "./run-evaluation";

/**
 * State of the AI workspace (Phase 6). Evaluations run in a worker on a frozen snapshot; proposals,
 * decisions and executions go through the twin API. Every failure records the operation that
 * failed and a `retry` that repeats exactly that operation.
 */

/** Shortest interval between progress updates shown while an evaluation runs. */
const PROGRESS_MS = 250;

/**
 * Workers report progress about 25 times a second; the page shows it at most every PROGRESS_MS
 * (a new stage at once), because each update re-renders and lays out the progress view.
 */
function coalesce<P extends { readonly stage: string }>(publish: (p: P) => void) {
  let shown: string | null = null;
  let pending: P | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const show = (p: P) => {
    shown = p.stage;
    pending = null;
    publish(p);
  };
  return {
    push(p: P) {
      if (p.stage !== shown) {
        if (timer) clearTimeout(timer);
        timer = null;
        show(p);
        return;
      }
      pending = p;
      timer ??= setTimeout(() => {
        timer = null;
        if (pending) show(pending);
      }, PROGRESS_MS);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export type Operation =
  | "capabilities"
  | "proposals"
  | "evaluate"
  | "save"
  | "load"
  | "decide"
  | "execute"
  | "report"
  | "explain"
  | "robustness";

export type WorkspaceFailure =
  | { readonly kind: "api"; readonly failure: ApiFailure }
  | { readonly kind: "twin"; readonly code: string; readonly message: string };

export interface FailedOperation {
  readonly op: Operation;
  readonly title: string;
  readonly failure: WorkspaceFailure;
  /** Repeats exactly the request that failed; null when repeating it cannot help. */
  readonly retry: (() => Promise<void>) | null;
  /** Another way to do the same thing, offered explicitly (never taken silently). */
  readonly alternative?: { readonly label: string; readonly run: () => Promise<void> };
}

/** How an evaluation was computed, shown with its result. */
export interface RunInfo {
  readonly mode: ExecutionMode;
  readonly workers: number;
  readonly elapsedMs: number;
}

export type EvaluationState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly what: "optimize" | "compare";
      readonly tick: number;
      readonly mode: ExecutionMode;
      /** performance.now() at the start, for the elapsed time. */
      readonly startedAt: number;
      readonly progress: Progress | null;
    }
  /** The operator cancelled: nothing was saved and the live run was not touched. */
  | { readonly kind: "cancelled"; readonly tick: number }
  | {
      readonly kind: "done";
      readonly result: Evaluation;
      /** The input, kept for multi-seed validation (null for a proposal loaded from the API). */
      readonly snapshot: Snapshot | null;
      /** How it was computed here; null for a proposal loaded from the API. */
      readonly run: RunInfo | null;
    };

/** Multi-seed validation of one candidate of the evaluation on screen (Phase 6.2). */
export type RobustnessState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly candidateId: string;
      readonly seeds: number;
      readonly mode: ExecutionMode;
      readonly startedAt: number;
      readonly progress: RobustnessProgress | null;
    }
  /** Cancelled: no verdict exists for it. */
  | { readonly kind: "cancelled"; readonly candidateId: string; readonly seeds: number }
  | { readonly kind: "done"; readonly result: RobustnessEvaluation; readonly run: RunInfo };

export type Load<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "failed" };

export interface TwinWorkspace {
  readonly operator: string;
  readonly horizonTicks: number;
  readonly evaluation: EvaluationState;
  readonly robustness: RobustnessState;
  /** Seeds for the next multi-seed validation. */
  readonly seedCount: number;
  readonly proposal: ProposalDetail | null;
  readonly selected: string | null;
  readonly busy: Operation | null;
  readonly failed: FailedOperation | null;
  /** Approval or execution found the proposal stale (it is now expired). */
  readonly stale: string | null;
  /** Someone else changed the proposal meanwhile (409 conflict); it was reloaded. */
  readonly conflict: string | null;
  readonly lastExplanation: Explanation | null;
  readonly capabilities: Load<Capabilities>;
  readonly proposals: Load<readonly ProposalSummary[]>;

  setOperator(name: string): void;
  setHorizon(ticks: number): void;
  select(candidateId: string): void;
  loadCapabilities(): Promise<void>;
  loadProposals(): Promise<void>;
  optimize(): Promise<void>;
  compare(counts: ReadonlyMap<string, number>): Promise<void>;
  cancel(): void;
  setSeedCount(seeds: number): void;
  /** Validate the selected candidate across `seedCount` seeds. Advisory: nothing is stored. */
  validateRobustness(): Promise<void>;
  cancelRobustness(): void;
  open(proposalId: string): Promise<void>;
  decide(decision: "approve" | "reject", note: string): Promise<void>;
  execute(): Promise<void>;
  explain(): Promise<void>;
  dismiss(): void;
}

const OPERATOR_KEY = "warehouse-one.operator";

/**
 * `?twinExecution=main-thread` runs evaluations on the main thread, labelled as such: for
 * benchmarks and for diagnosing a browser where workers misbehave. Default: background workers.
 */
function requestedMode(): ExecutionMode {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("twinExecution") ===
      "main-thread"
      ? "main_thread"
      : "worker";
  } catch {
    return "worker";
  }
}
let running: AbortController | null = null;
let validating: AbortController | null = null;

function storedOperator(): string {
  try {
    return globalThis.localStorage?.getItem(OPERATOR_KEY) ?? "";
  } catch {
    return "";
  }
}

function toFailure(e: unknown): WorkspaceFailure {
  if (e instanceof ApiRequestError) return { kind: "api", failure: e.failure };
  if (e instanceof EvaluationFailed) return { kind: "twin", code: e.code, message: e.message };
  return {
    kind: "twin",
    code: "UNEXPECTED",
    message: e instanceof Error ? e.message : "Something went wrong.",
  };
}

const httpCode = (e: unknown): string | null =>
  e instanceof ApiRequestError && e.failure.kind === "http" ? e.failure.code : null;

const live = () => {
  const { config, state } = useSimulation.getState();
  return liveContext(config, state);
};

export const useTwin = create<TwinWorkspace>()((set, get) => {
  const fail = (
    op: Operation,
    title: string,
    e: unknown,
    retry: (() => Promise<void>) | null,
  ): void => set({ busy: null, failed: { op, title, failure: toFailure(e), retry } });

  const actor = () => get().operator.trim() || "operator";

  /** Store an evaluation as a proposal (the server re-validates it). */
  const save = async (result: Evaluation, snapshot: Snapshot): Promise<void> => {
    set({ busy: "save", failed: null });
    try {
      const proposal = await twinApi.create(result, snapshot, actor());
      const ev = get().evaluation;
      set({
        proposal,
        busy: null,
        evaluation: {
          kind: "done",
          result,
          snapshot,
          run: ev.kind === "done" ? ev.run : null,
        },
      });
      void get().loadProposals();
    } catch (e) {
      fail("save", "The evaluation could not be saved as a proposal", e, () =>
        save(result, snapshot),
      );
    }
  };

  const evaluate = async (
    request: EvaluationRequest,
    tick: number,
    mode: ExecutionMode = "worker",
  ): Promise<void> => {
    running?.abort();
    // A validation belongs to the result on screen, which this replaces.
    validating?.abort();
    validating = null;
    const ctl = new AbortController();
    running = ctl;
    set({
      robustness: { kind: "idle" },
      evaluation: {
        kind: "running",
        what: request.kind,
        tick,
        mode,
        startedAt: performance.now(),
        progress: null,
      },
      proposal: null,
      selected: null,
      failed: null,
      stale: null,
      conflict: null,
      lastExplanation: null,
      busy: "evaluate",
    });
    const progress = coalesce<Progress>((p) => {
      const ev = get().evaluation;
      // Only the current request may update the workspace: a stale one is ignored.
      if (running === ctl && ev.kind === "running") set({ evaluation: { ...ev, progress: p } });
    });
    try {
      const run = await runEvaluation(request, progress.push, ctl.signal, mode);
      progress.stop();
      if (running !== ctl) return;
      running = null;
      const result = run.evaluation;
      set({
        evaluation: {
          kind: "done",
          result,
          snapshot: request.snapshot,
          run: { mode: run.mode, workers: run.workers, elapsedMs: run.elapsedMs },
        },
        selected: result.recommendation?.candidate_id ?? result.candidates[0]?.candidate_id ?? null,
        busy: null,
      });
      await save(result, request.snapshot);
    } catch (e) {
      progress.stop();
      if (running !== ctl) return;
      running = null;
      if (e instanceof EvaluationFailed && e.code === "CANCELLED") {
        set({ evaluation: { kind: "cancelled", tick }, busy: null });
        return;
      }
      set({ evaluation: { kind: "idle" } });
      fail("evaluate", "The evaluation failed", e, () => evaluate(request, tick, mode));
      const workerProblem =
        e instanceof EvaluationFailed &&
        ["WORKER_UNAVAILABLE", "WORKER_CRASHED", "WORKER_TIMEOUT"].includes(e.code);
      if (workerProblem && mode === "worker") {
        const failed = get().failed;
        if (failed)
          set({
            failed: {
              ...failed,
              alternative: {
                label: "Run on the main thread instead (slower; the page may stutter)",
                run: () => evaluate(request, tick, "main_thread"),
              },
            },
          });
      }
    }
  };

  /** Multi-seed validation of one candidate (Phase 6.2). Advisory: never saved, never approves. */
  const validate = async (
    snapshot: Snapshot,
    discovery: Evaluation,
    candidateId: string,
    seeds: number,
    mode: ExecutionMode,
  ): Promise<void> => {
    validating?.abort();
    const ctl = new AbortController();
    validating = ctl;
    set({
      robustness: {
        kind: "running",
        candidateId,
        seeds,
        mode,
        startedAt: performance.now(),
        progress: null,
      },
      failed: null,
    });
    const current = () => validating === ctl;
    const progress = coalesce<RobustnessProgress>((p) => {
      const r = get().robustness;
      if (current() && r.kind === "running") set({ robustness: { ...r, progress: p } });
    });
    try {
      const run = await runRobustness(
        snapshot,
        discovery,
        candidateId,
        { seeds },
        progress.push,
        ctl.signal,
        mode,
      );
      progress.stop();
      if (!current()) return;
      validating = null;
      set({
        robustness: {
          kind: "done",
          result: run.robustness,
          run: { mode: run.mode, workers: run.workers, elapsedMs: run.elapsedMs },
        },
      });
    } catch (e) {
      progress.stop();
      if (!current()) return;
      validating = null;
      if (e instanceof EvaluationFailed && e.code === "CANCELLED") {
        set({ robustness: { kind: "cancelled", candidateId, seeds } });
        return;
      }
      // A failure leaves no partial result and no verdict.
      set({ robustness: { kind: "idle" } });
      fail("robustness", "The multi-seed validation failed", e, () =>
        validate(snapshot, discovery, candidateId, seeds, mode),
      );
      const workerProblem =
        e instanceof EvaluationFailed &&
        ["WORKER_UNAVAILABLE", "WORKER_CRASHED", "WORKER_TIMEOUT"].includes(e.code);
      const failed = get().failed;
      if (workerProblem && mode === "worker" && failed)
        set({
          failed: {
            ...failed,
            alternative: {
              label: "Run on the main thread instead (slower; the page may stutter)",
              run: () => validate(snapshot, discovery, candidateId, seeds, "main_thread"),
            },
          },
        });
    }
  };

  const snapshotNow = () => {
    const { config, state } = useSimulation.getState();
    return { snapshot: createSnapshot(config, state), tick: state.tick };
  };

  const reload = async (id: string, note: string): Promise<void> => {
    try {
      set({ proposal: await twinApi.get(id), conflict: note });
    } catch {
      set({ conflict: note });
    }
  };

  /** Report what the engine did; retried on its own if the API was unreachable. */
  const report = async (id: string, body: Parameters<typeof twinApi.report>[1]): Promise<void> => {
    set({ busy: "report", failed: null });
    try {
      const proposal = await twinApi.report(id, body);
      set({ proposal, busy: null });
      void get().loadProposals();
    } catch (e) {
      fail(
        "report",
        body.outcome === "applied"
          ? "Applied in the simulation, but the API has not recorded it yet"
          : "The failed execution could not be recorded",
        e,
        () => report(id, body),
      );
    }
  };

  return {
    operator: storedOperator(),
    horizonTicks: 18_000,
    evaluation: { kind: "idle" },
    robustness: { kind: "idle" },
    seedCount: SEED_TIERS[1].seeds,
    proposal: null,
    selected: null,
    busy: null,
    failed: null,
    stale: null,
    conflict: null,
    lastExplanation: null,
    capabilities: { kind: "loading" },
    proposals: { kind: "loading" },

    setOperator(name) {
      set({ operator: name });
      try {
        globalThis.localStorage?.setItem(OPERATOR_KEY, name);
      } catch {
        // Private mode: the name is kept for this session only.
      }
    },
    setHorizon: (ticks) => set({ horizonTicks: ticks }),
    select: (candidateId) => set({ selected: candidateId }),
    dismiss: () => set({ failed: null, conflict: null }),

    async loadCapabilities() {
      set({ capabilities: { kind: "loading" } });
      try {
        set({ capabilities: { kind: "ready", data: await twinApi.capabilities() } });
        if (get().failed?.op === "capabilities") set({ failed: null });
      } catch (e) {
        set({ capabilities: { kind: "failed" } });
        fail("capabilities", "The digital-twin API is not available", e, () =>
          get().loadCapabilities(),
        );
      }
    },

    async loadProposals() {
      const sim = useSimulation.getState().config.simulation_id;
      try {
        const list = await twinApi.list(sim);
        set({ proposals: { kind: "ready", data: list.items } });
      } catch {
        // The capabilities request reports an unreachable API; the list just stays empty.
        set({ proposals: { kind: "failed" } });
      }
    },

    optimize() {
      const { snapshot, tick } = snapshotNow();
      return evaluate(
        { kind: "optimize", snapshot, options: { horizon_ticks: get().horizonTicks } },
        tick,
        requestedMode(),
      );
    },

    compare(counts) {
      const { snapshot, tick } = snapshotNow();
      const plan = assignCounts(currentPlan(snapshot.state), counts);
      return evaluate(
        {
          kind: "compare",
          snapshot,
          alternatives: [{ label: "Your plan", plan }],
          options: { horizon_ticks: get().horizonTicks, max_evaluations: 2 },
        },
        tick,
        requestedMode(),
      );
    },

    cancel() {
      running?.abort();
    },

    setSeedCount: (seeds) => set({ seedCount: seeds }),

    validateRobustness() {
      const ev = get().evaluation;
      const candidateId = get().selected;
      if (ev.kind !== "done" || !ev.snapshot || !candidateId) return Promise.resolve();
      return validate(ev.snapshot, ev.result, candidateId, get().seedCount, requestedMode());
    },

    cancelRobustness() {
      validating?.abort();
    },

    async open(proposalId) {
      running?.abort();
      validating?.abort();
      validating = null;
      set({ robustness: { kind: "idle" } });
      set({ busy: "load", failed: null, stale: null, conflict: null, lastExplanation: null });
      try {
        const proposal = await twinApi.get(proposalId);
        set({
          proposal,
          evaluation: { kind: "done", result: proposal.evaluation, snapshot: null, run: null },
          selected:
            proposal.evaluation.recommendation?.candidate_id ??
            proposal.evaluation.candidates[0]?.candidate_id ??
            null,
          busy: null,
        });
      } catch (e) {
        fail("load", "The proposal could not be loaded", e, () => get().open(proposalId));
      }
    },

    async decide(decision, note) {
      const p = get().proposal;
      if (!p) return;
      set({ busy: "decide", failed: null, stale: null, conflict: null });
      try {
        const proposal = await twinApi.decide(p.proposal_id, {
          decision,
          actor: actor(),
          ...(note.trim() ? { note: note.trim() } : {}),
          expected_version: p.version,
          ...(decision === "approve" ? { context: live() } : {}),
        });
        set({ proposal, busy: null });
        void get().loadProposals();
      } catch (e) {
        set({ busy: null });
        const code = httpCode(e);
        if (code === "STALE_PROPOSAL") {
          set({ stale: e instanceof ApiRequestError ? e.message : "The proposal is stale." });
          await reload(p.proposal_id, "");
          set({ conflict: null });
          void get().loadProposals();
        } else if (code === "VERSION_CONFLICT" || code === "INVALID_TRANSITION") {
          await reload(
            p.proposal_id,
            "The proposal changed meanwhile (another decision was recorded). It has been reloaded: check its status before acting again.",
          );
        } else
          fail("decide", `The ${decision} decision was not recorded`, e, () =>
            get().decide(decision, note),
          );
      }
    },

    async execute() {
      const p = get().proposal;
      if (!p) return;
      if (useSimulation.getState().paused) {
        set({
          failed: {
            op: "execute",
            title: "The simulation is paused",
            failure: {
              kind: "twin",
              code: "SIMULATION_PAUSED",
              message: "Resume the simulation first: approved commands apply on its next tick.",
            },
            retry: null,
          },
        });
        return;
      }
      set({ busy: "execute", failed: null, stale: null, conflict: null });
      let claim: Awaited<ReturnType<typeof twinApi.claim>>;
      try {
        claim = await twinApi.claim(p.proposal_id, {
          actor: actor(),
          context: live(),
          expected_version: p.version,
        });
      } catch (e) {
        set({ busy: null });
        const code = httpCode(e);
        if (code === "STALE_PROPOSAL") {
          set({ stale: e instanceof ApiRequestError ? e.message : "The proposal is stale." });
          await reload(p.proposal_id, "");
          set({ conflict: null });
        } else if (
          code &&
          ["ALREADY_EXECUTED", "NOT_APPROVED", "VERSION_CONFLICT"].includes(code)
        ) {
          await reload(
            p.proposal_id,
            e instanceof ApiRequestError ? e.message : "The proposal changed meanwhile.",
          );
        } else fail("execute", "The execution could not be started", e, () => get().execute());
        return;
      }
      set({ proposal: claim.proposal });
      // Submit through the operator command path with the server's ids; the engine validates.
      const sim = useSimulation.getState();
      const immediate = new Map<string, { accepted: boolean; code?: string; message?: string }>();
      for (const c of claim.commands) {
        const record = sim.submitCommand({ type: c.type, payload: c.payload }, c.command_id);
        if (record.status === "rejected")
          immediate.set(c.command_id, {
            accepted: false,
            code: record.code,
            message: record.message,
          });
      }
      const waiting = claim.commands.map((c) => c.command_id).filter((id) => !immediate.has(id));
      let results: { command_id: string; accepted: boolean; code?: string; message?: string }[];
      let appliedTick: number | undefined;
      let note: string | undefined;
      try {
        const outcomes = waiting.length ? await commandOutcomes(waiting, 15_000) : [];
        appliedTick = outcomes[0]?.tick;
        const byId = new Map(outcomes.map((o) => [o.command_id, o]));
        results = claim.commands.map((c) => {
          const o = immediate.get(c.command_id) ?? byId.get(c.command_id);
          return {
            command_id: c.command_id,
            accepted: !!o?.accepted,
            ...(o?.code ? { code: o.code } : {}),
            ...(o?.message ? { message: o.message.slice(0, 500) } : {}),
          };
        });
      } catch (e) {
        note = e instanceof Error ? e.message : "The commands were not applied in time.";
        results = claim.commands.map((c) => ({
          command_id: c.command_id,
          accepted: false,
          message: "no engine result",
        }));
      }
      await report(p.proposal_id, {
        actor: actor(),
        outcome: results.every((r) => r.accepted) ? "applied" : "failed",
        ...(appliedTick !== undefined ? { applied_tick: appliedTick } : {}),
        results,
        ...(note ? { note: note.slice(0, 500) } : {}),
      });
    },

    async explain() {
      const p = get().proposal;
      if (!p) return;
      set({ busy: "explain", failed: null });
      try {
        const explanation = await twinApi.explain(p.proposal_id);
        set({ lastExplanation: explanation, busy: null });
        set({ proposal: await twinApi.get(p.proposal_id) });
      } catch (e) {
        fail(
          "explain",
          "No AI explanation",
          e,
          httpCode(e) === "AI_NOT_CONFIGURED" || httpCode(e) === "EXPLANATION_LIMIT"
            ? null
            : () => get().explain(),
        );
        try {
          set({ proposal: await twinApi.get(p.proposal_id) });
        } catch {
          // The failure above already says why; the stored attempt shows on the next load.
        }
      }
    },
  };
});
