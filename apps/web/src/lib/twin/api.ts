/**
 * Client of the digital-twin API (`/api/v1/twin`, Phase 6). Every response is validated with zod
 * before the workspace uses it; failures are explained by lib/api/request.ts (unreachable, CORS,
 * wrong server or version, API error, contract mismatch).
 */
import type { Evaluation, LiveContext } from "@warehouse-one/twin";
import type { Snapshot } from "@warehouse-one/simulation";
import { z } from "zod";
import { requestJson, type Feature } from "../api/request";

const TWIN: Feature = { name: "digital-twin API", since: "Phase 6 (digital twin)" };

const ts = z.iso.datetime({ offset: true });
const num = z.number().nullable();

const MetricDelta = z.object({
  key: z.string(),
  unit: z.enum(["s", "km", "transfers", "pallets"]),
  better: z.enum(["lower", "higher", "info"]),
  baseline: num,
  candidate: num,
  abs: num,
  pct: num,
  improved: z.boolean().nullable(),
});
const Constraint = z.object({
  id: z.string(),
  label: z.string(),
  stage: z.enum(["plan", "simulation"]),
  satisfied: z.boolean(),
  detail: z.string(),
});
const Plan = z.object({
  assignments: z.array(z.object({ vehicle_id: z.string(), site_id: z.string().nullable() })),
});
const Metrics = z.record(z.string(), num);

/** The stored evaluation (server-recomputed deltas); same shape as @warehouse-one/twin's. */
const EvaluationSchema = z.object({
  evaluation_id: z.uuid(),
  kind: z.enum(["optimization", "what_if"]),
  strategy: z.object({ id: z.string(), version: z.string() }),
  source: z.object({
    simulation_id: z.uuid(),
    tick: z.int(),
    sim_time_ms: z.int(),
    simulated_at: ts,
    state_hash: z.string(),
    config_hash: z.string(),
    fleet_fingerprint: z.string(),
    engine_version: z.string(),
  }),
  options: z.object({
    horizon_ticks: z.int(),
    max_evaluations: z.int(),
    min_improvement_pct: z.number(),
    min_improvement_s: z.number(),
    service_floor_pct: z.number(),
  }),
  objective: z.object({ metric: z.string(), direction: z.literal("minimize") }),
  demand: z.array(
    z.object({
      site_id: z.string(),
      site_name: z.string(),
      transfers_per_hour: z.number(),
      backlog: z.int(),
      standby_capacity: z.int(),
    }),
  ),
  baseline: z.object({
    plan: Plan,
    metrics: Metrics,
    constraints: z.array(Constraint),
    end_state_hash: z.string(),
  }),
  candidates: z.array(
    z.object({
      candidate_id: z.string(),
      label: z.string(),
      origin: z.string(),
      plan: Plan,
      changes: z.array(
        z.object({
          vehicle_id: z.string(),
          from: z.string().nullable(),
          to: z.string().nullable(),
        }),
      ),
      constraints: z.array(Constraint),
      feasible: z.boolean(),
      metrics: Metrics.nullable(),
      deltas: z.array(MetricDelta),
      verdict: z.enum(["recommended", "improves", "no_better", "infeasible"]),
      rank: z.int().nullable(),
      reasons: z.array(z.string()),
      end_state_hash: z.string().nullable(),
    }),
  ),
  recommendation: z
    .object({ candidate_id: z.string(), summary: z.string(), reasons: z.array(z.string()) })
    .nullable(),
  no_recommendation_reason: z.string().nullable(),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  search: z.object({
    simulations: z.int(),
    budget: z.int(),
    plans_considered: z.int(),
    exhausted_budget: z.boolean(),
  }),
  runtime: z.object({ elapsed_ms: z.int(), ticks_simulated: z.int() }),
});

export const PROPOSAL_STATUSES = [
  "generated",
  "validated",
  "not_actionable",
  "invalid",
  "approved",
  "rejected",
  "executing",
  "applied",
  "failed",
  "expired",
  "superseded",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
const Status = z.enum(PROPOSAL_STATUSES);

const Summary = z.object({
  proposal_id: z.uuid(),
  evaluation_id: z.uuid(),
  kind: z.enum(["optimization", "what_if"]),
  status: Status,
  version: z.int(),
  strategy: z.object({ id: z.string(), version: z.string() }),
  simulation_id: z.uuid(),
  source_tick: z.int(),
  source_business_time: ts,
  headline: z.string(),
  objective: z.object({ metric: z.string(), baseline: num, candidate: num, pct: num }),
  recommended_candidate_id: z.string().nullable(),
  created_by: z.string(),
  created_at: ts,
  updated_at: ts,
  decided_by: z.string().nullable(),
  decided_at: ts.nullable(),
});
export type ProposalSummary = z.infer<typeof Summary>;

export const AiExplanation = z.object({
  headline: z.string(),
  explanation: z.string(),
  trade_offs: z.array(z.string()),
  risks: z.array(z.string()),
  operator_checks: z.array(z.string()),
  cited_metrics: z.array(z.object({ metric: z.string(), baseline: num, candidate: num })),
  stance: z.enum(["supports_approval", "advises_caution", "advises_rejection", "not_applicable"]),
});
const Explanation = z.object({
  explanation_id: z.uuid(),
  provenance: z.literal("ai_generated"),
  status: z.enum(["ok", "failed"]),
  provider: z.string(),
  model: z.string(),
  prompt_version: z.string(),
  content: AiExplanation.nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  latency_ms: z.int(),
  created_at: ts,
});
export type Explanation = z.infer<typeof Explanation>;

const Command = z.object({
  command_id: z.string(),
  type: z.literal("linehaul.set_standby"),
  payload: z.object({ vehicle_id: z.string(), site_id: z.string().nullable() }),
});
export type StandbyCommand = z.infer<typeof Command>;

const Detail = Summary.extend({
  evaluation: EvaluationSchema,
  validation: z.array(
    z.object({ id: z.string(), label: z.string(), passed: z.boolean(), detail: z.string() }),
  ),
  commands: z.array(Command),
  history: z.array(
    z.object({
      action: z.string(),
      from_status: Status.nullable(),
      to_status: Status,
      actor: z.string(),
      note: z.string().nullable(),
      details: z.record(z.string(), z.unknown()),
      recorded_at: ts,
    }),
  ),
  explanations: z.array(Explanation),
  decision_note: z.string().nullable(),
  executed_tick: z.int().nullable(),
  max_age_ticks: z.int(),
});
export type ProposalDetail = Omit<z.infer<typeof Detail>, "evaluation"> & {
  readonly evaluation: Evaluation;
};

const ProposalList = z.object({ items: z.array(Summary), next_cursor: z.string().nullable() });
export type ProposalList = z.infer<typeof ProposalList>;

const Capabilities = z.object({
  strategies: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
      objective: z.string(),
      description: z.string(),
      hard_constraints: z.array(z.string()),
    }),
  ),
  ai: z.object({
    provider: z.enum(["none", "anthropic"]),
    model: z.string().nullable(),
    configured: z.boolean(),
    detail: z.string(),
  }),
  execution: z.record(z.string(), z.unknown()),
  lifecycle: z.record(z.string(), z.array(z.string())),
  limits: z.record(z.string(), z.int()),
});
export type Capabilities = z.infer<typeof Capabilities>;

const Claim = z.object({ proposal: Detail, commands: z.array(Command) });

/** The evaluation types match the twin package's interface (checked by schema, then typed). */
const asDetail = (d: z.infer<typeof Detail>): ProposalDetail => d as unknown as ProposalDetail;

const P = "/api/v1/twin/proposals";

export const twinApi = {
  capabilities: (signal?: AbortSignal) =>
    requestJson(TWIN, "/api/v1/twin/capabilities", Capabilities, { signal }),
  list: (simulationId: string | null, signal?: AbortSignal) => {
    const q = new URLSearchParams({ limit: "10" });
    if (simulationId) q.set("simulation_id", simulationId);
    return requestJson(TWIN, `${P}?${q}`, ProposalList, { signal });
  },
  get: async (id: string, signal?: AbortSignal) =>
    asDetail(await requestJson(TWIN, `${P}/${id}`, Detail, { signal })),
  create: async (evaluation: Evaluation, snapshot: Snapshot, createdBy: string) =>
    asDetail(
      await requestJson(TWIN, P, Detail, {
        method: "POST",
        body: { evaluation, snapshot, created_by: createdBy },
        timeoutMs: 20_000,
      }),
    ),
  decide: async (
    id: string,
    body: {
      decision: "approve" | "reject";
      actor: string;
      note?: string;
      expected_version: number;
      context?: LiveContext;
    },
  ) => asDetail(await requestJson(TWIN, `${P}/${id}/decision`, Detail, { method: "POST", body })),
  claim: async (
    id: string,
    body: { actor: string; context: LiveContext; expected_version: number },
  ) => {
    const c = await requestJson(TWIN, `${P}/${id}/execution`, Claim, { method: "POST", body });
    return { proposal: asDetail(c.proposal), commands: c.commands };
  },
  report: async (
    id: string,
    body: {
      actor: string;
      outcome: "applied" | "failed";
      applied_tick?: number;
      results: { command_id: string; accepted: boolean; code?: string; message?: string }[];
      note?: string;
    },
  ) =>
    asDetail(
      await requestJson(TWIN, `${P}/${id}/execution/result`, Detail, { method: "POST", body }),
    ),
  explain: (id: string) =>
    requestJson(TWIN, `${P}/${id}/explanations`, Explanation, {
      method: "POST",
      body: {},
      timeoutMs: 90_000,
    }),
};
