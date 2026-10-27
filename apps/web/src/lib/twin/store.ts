"use client";

import { createSnapshot, type Snapshot } from "@warehouse-one/simulation";
import {
  assignCounts,
  currentPlan,
  liveContext,
  type Evaluation,
  type Progress,
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
import { EvaluationFailed, runEvaluation } from "./run-evaluation";

/**
 * State of the AI workspace (Phase 6). Evaluations run in a worker on a frozen snapshot; proposals,
 * decisions and executions go through the twin API. Every failure records the operation that
 * failed and a `retry` that repeats exactly that operation.
 */

export type Operation =
  | "capabilities"
  | "proposals"
  | "evaluate"
  | "save"
  | "load"
  | "decide"
  | "execute"
  | "report"
  | "explain";

export type WorkspaceFailure =
  | { readonly kind: "api"; readonly failure: ApiFailure }
  | { readonly kind: "twin"; readonly code: string; readonly message: string };

export interface FailedOperation {
  readonly op: Operation;
  readonly title: string;
  readonly failure: WorkspaceFailure;
  /** Repeats exactly the request that failed; null when repeating it cannot help. */
  readonly retry: (() => Promise<void>) | null;
}

export type EvaluationState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly what: "optimize" | "compare";
      readonly tick: number;
      readonly progress: Progress | null;
    }
  | {
      readonly kind: "done";
      readonly result: Evaluation;
      /** The input, kept until the proposal is stored (null for a proposal loaded from the API). */
      readonly snapshot: Snapshot | null;
    };

export type Load<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "failed" };

export interface TwinWorkspace {
  readonly operator: string;
  readonly horizonTicks: number;
  readonly evaluation: EvaluationState;
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
  open(proposalId: string): Promise<void>;
  decide(decision: "approve" | "reject", note: string): Promise<void>;
  execute(): Promise<void>;
  explain(): Promise<void>;
  dismiss(): void;
}

const OPERATOR_KEY = "warehouse-one.operator";
let running: AbortController | null = null;

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
      set({ proposal, busy: null, evaluation: { kind: "done", result, snapshot: null } });
      void get().loadProposals();
    } catch (e) {
      fail("save", "The evaluation could not be saved as a proposal", e, () =>
        save(result, snapshot),
      );
    }
  };

  const evaluate = async (request: EvaluationRequest, tick: number): Promise<void> => {
    running?.abort();
    const ctl = new AbortController();
    running = ctl;
    set({
      evaluation: { kind: "running", what: request.kind, tick, progress: null },
      proposal: null,
      selected: null,
      failed: null,
      stale: null,
      conflict: null,
      lastExplanation: null,
      busy: "evaluate",
    });
    try {
      const result = await runEvaluation(
        request,
        (progress) => {
          const ev = get().evaluation;
          if (running === ctl && ev.kind === "running") set({ evaluation: { ...ev, progress } });
        },
        ctl.signal,
      );
      if (running !== ctl) return;
      running = null;
      set({
        evaluation: { kind: "done", result, snapshot: request.snapshot },
        selected: result.recommendation?.candidate_id ?? result.candidates[0]?.candidate_id ?? null,
        busy: null,
      });
      await save(result, request.snapshot);
    } catch (e) {
      if (running !== ctl) return;
      running = null;
      if (e instanceof EvaluationFailed && e.code === "CANCELLED") {
        set({ evaluation: { kind: "idle" }, busy: null });
        return;
      }
      set({ evaluation: { kind: "idle" } });
      fail("evaluate", "The evaluation failed", e, () => evaluate(request, tick));
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
      );
    },

    cancel() {
      running?.abort();
    },

    async open(proposalId) {
      running?.abort();
      set({ busy: "load", failed: null, stale: null, conflict: null, lastExplanation: null });
      try {
        const proposal = await twinApi.get(proposalId);
        set({
          proposal,
          evaluation: { kind: "done", result: proposal.evaluation, snapshot: null },
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
