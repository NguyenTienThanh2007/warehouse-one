"""Contracts of the digital-twin API (Phase 6).

`Evaluation` mirrors `@warehouse-one/twin` (packages/twin/src/optimizer.ts): what the optimiser
evaluated in the browser, from a frozen snapshot of the live run. The server does not re-simulate
(the TypeScript engine is the only simulator, DEC-039); it validates the evaluation against its
own snapshot, recomputes every delta from the metrics, re-checks the plan's hard rules, and owns
the proposal lifecycle and audit trail.
"""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from warehouse_api.contracts.events import EntityId

ShortText = Annotated[str, StringConstraints(max_length=200)]
LongText = Annotated[str, StringConstraints(max_length=2_000)]
Hash = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[0-9a-f]+$")]
Actor = Annotated[
    str,
    StringConstraints(min_length=1, max_length=80, pattern=r"^[^\x00-\x1f\x7f]+$"),
    Field(description="Who acts: an operator name. Not authenticated before Phase 7."),
]
Note = Annotated[
    str, StringConstraints(max_length=500, pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$")
]

MetricKey = Literal[
    "pickup_wait_s",
    "pickup_wait_p90_s",
    "empty_km",
    "loaded_km",
    "transfers_planned",
    "pallets_planned",
    "transfers_delivered",
    "pallets_delivered",
    "transfers_cancelled",
    "transfers_waiting_end",
    "lead_time_s",
]

ProposalStatus = Literal[
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
]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


NonNeg = Annotated[float, Field(ge=0)]
Count = Annotated[int, Field(ge=0)]


class FleetMetrics(_Strict):
    """Simulated fleet metrics over the horizon (units in the names)."""

    pickup_wait_s: NonNeg | None
    pickup_wait_p90_s: NonNeg | None
    empty_km: NonNeg
    loaded_km: NonNeg
    transfers_planned: Count
    pallets_planned: Count
    transfers_delivered: Count
    pallets_delivered: Count
    transfers_cancelled: Count
    transfers_waiting_end: Count
    lead_time_s: NonNeg | None


class Assignment(_Strict):
    vehicle_id: EntityId
    site_id: EntityId | None


class StandbyPlan(_Strict):
    assignments: Annotated[list[Assignment], Field(max_length=64)]


class PlanChange(_Strict):
    vehicle_id: EntityId
    from_: EntityId | None = Field(alias="from")
    to: EntityId | None


class Constraint(_Strict):
    id: Annotated[str, StringConstraints(max_length=64)]
    label: ShortText
    stage: Literal["plan", "simulation"]
    satisfied: bool
    detail: LongText


class MetricDelta(_Strict):
    key: MetricKey
    unit: Literal["s", "km", "transfers", "pallets"]
    better: Literal["lower", "higher", "info"]
    baseline: float | None
    candidate: float | None
    abs: float | None
    pct: float | None
    improved: bool | None


class Candidate(_Strict):
    candidate_id: Annotated[str, StringConstraints(max_length=16)]
    # Names the trucks per site, so it grows with the fleet.
    label: Annotated[str, StringConstraints(max_length=400)]
    origin: Literal["proportional", "busiest_origin", "local_search", "user"]
    plan: StandbyPlan
    changes: Annotated[list[PlanChange], Field(max_length=64)]
    constraints: Annotated[list[Constraint], Field(max_length=16)]
    feasible: bool
    metrics: FleetMetrics | None
    deltas: Annotated[list[MetricDelta], Field(max_length=16)]
    verdict: Literal["recommended", "improves", "no_better", "infeasible"]
    rank: int | None
    reasons: Annotated[list[LongText], Field(max_length=16)]
    end_state_hash: Hash | None


# Simulated business time exactly as the engine formats it (kept as text, so a stored evaluation
# stays byte-identical to the computed one and can be verified by re-running it).
SimulatedAt = Annotated[
    str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
]


class Source(_Strict):
    simulation_id: UUID
    tick: Count
    sim_time_ms: Count
    simulated_at: SimulatedAt
    state_hash: Hash
    config_hash: Hash
    fleet_fingerprint: Hash
    engine_version: Annotated[str, StringConstraints(max_length=32)]


class Options(_Strict):
    horizon_ticks: Annotated[int, Field(ge=3_000, le=36_000)]
    max_evaluations: Annotated[int, Field(ge=2, le=12)]
    min_improvement_pct: Annotated[float, Field(ge=0, le=100)]
    min_improvement_s: NonNeg
    service_floor_pct: Annotated[float, Field(ge=0, le=100)]


class Strategy(_Strict):
    id: Literal["fleet-standby"]
    version: Annotated[str, StringConstraints(max_length=16)]


class Objective(_Strict):
    metric: MetricKey
    direction: Literal["minimize"]


class SiteDemand(_Strict):
    site_id: EntityId
    site_name: ShortText
    transfers_per_hour: NonNeg
    backlog: Count
    standby_capacity: Count


class Baseline(_Strict):
    plan: StandbyPlan
    metrics: FleetMetrics
    constraints: Annotated[list[Constraint], Field(max_length=16)]
    end_state_hash: Hash


class Recommendation(_Strict):
    candidate_id: Annotated[str, StringConstraints(max_length=16)]
    summary: LongText
    reasons: Annotated[list[LongText], Field(max_length=16)]


class Search(_Strict):
    simulations: Count
    budget: Count
    plans_considered: Count
    exhausted_budget: bool


class Runtime(_Strict):
    elapsed_ms: Count
    ticks_simulated: Count


class Evaluation(_Strict):
    evaluation_id: UUID
    kind: Literal["optimization", "what_if"]
    strategy: Strategy
    source: Source
    options: Options
    objective: Objective
    demand: Annotated[list[SiteDemand], Field(max_length=32)]
    baseline: Baseline
    candidates: Annotated[list[Candidate], Field(max_length=12)]
    recommendation: Recommendation | None
    no_recommendation_reason: LongText | None
    assumptions: Annotated[list[LongText], Field(max_length=20)]
    risks: Annotated[list[LongText], Field(max_length=20)]
    search: Search
    runtime: Runtime


class InputSnapshot(_Strict):
    """A simulation snapshot (packages/simulation/src/snapshot.ts). Stored as given."""

    snapshot_version: int
    engine_version: Annotated[str, StringConstraints(max_length=32)]
    config: dict[str, Any]
    state: dict[str, Any]
    state_hash: Hash


class ProposalCreate(_Strict):
    evaluation: Evaluation
    snapshot: InputSnapshot
    created_by: Actor = "operator"


class LiveContext(_Strict):
    """The live run as the browser sees it when the operator acts (twin/context.ts)."""

    simulation_id: UUID
    config_hash: Hash
    tick: Count
    fleet_fingerprint: Hash


class DecisionRequest(_Strict):
    decision: Literal["approve", "reject"]
    actor: Actor
    note: Note | None = None
    # Optimistic concurrency: refuse if the proposal changed since the client read it.
    expected_version: Annotated[int, Field(ge=1)] | None = None
    # Required to approve: approval checks that the proposal is still about the live run.
    context: LiveContext | None = None


class ExecutionRequest(_Strict):
    actor: Actor
    context: LiveContext
    expected_version: Annotated[int, Field(ge=1)] | None = None


class CommandResult(_Strict):
    command_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    accepted: bool
    code: Annotated[str, StringConstraints(max_length=64)] | None = None
    message: Note | None = None


class ExecutionReport(_Strict):
    actor: Actor
    outcome: Literal["applied", "failed"]
    applied_tick: Count | None = None
    results: Annotated[list[CommandResult], Field(max_length=64)]
    note: Note | None = None


class ValidationCheck(_Strict):
    id: str
    label: str
    passed: bool
    detail: str


class AuditEntry(_Strict):
    action: str
    from_status: ProposalStatus | None
    to_status: ProposalStatus
    actor: str
    note: str | None
    details: dict[str, Any]
    recorded_at: datetime


class CitedMetric(_Strict):
    metric: MetricKey
    baseline: float | None
    candidate: float | None


class AiExplanation(_Strict):
    """What the language model may say: prose about computed facts, never new facts or actions."""

    headline: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    explanation: Annotated[str, StringConstraints(min_length=1, max_length=2_000)]
    trade_offs: Annotated[
        list[Annotated[str, StringConstraints(max_length=400)]], Field(max_length=6)
    ]
    risks: Annotated[list[Annotated[str, StringConstraints(max_length=400)]], Field(max_length=6)]
    operator_checks: Annotated[
        list[Annotated[str, StringConstraints(max_length=400)]], Field(max_length=6)
    ]
    cited_metrics: Annotated[list[CitedMetric], Field(max_length=11)]
    stance: Literal["supports_approval", "advises_caution", "advises_rejection", "not_applicable"]


class Explanation(_Strict):
    explanation_id: UUID
    # Always AI-generated prose: never measured or computed values.
    provenance: Literal["ai_generated"] = "ai_generated"
    status: Literal["ok", "failed"]
    provider: str
    model: str
    prompt_version: str
    content: AiExplanation | None
    error_code: str | None
    error_message: str | None
    latency_ms: int
    created_at: datetime


class ObjectiveSummary(_Strict):
    metric: MetricKey
    baseline: float | None
    candidate: float | None
    pct: float | None


class ProposalSummary(_Strict):
    proposal_id: UUID
    evaluation_id: UUID
    kind: Literal["optimization", "what_if"]
    status: ProposalStatus
    version: int
    strategy: Strategy
    simulation_id: UUID
    source_tick: int
    source_business_time: datetime
    headline: str
    objective: ObjectiveSummary
    recommended_candidate_id: str | None
    created_by: str
    created_at: datetime
    updated_at: datetime
    decided_by: str | None
    decided_at: datetime | None


class ProposalDetail(ProposalSummary):
    evaluation: Evaluation
    validation: list[ValidationCheck]
    commands: list[dict[str, Any]]
    history: list[AuditEntry]
    explanations: list[Explanation]
    decision_note: str | None
    executed_tick: int | None
    max_age_ticks: int


class ProposalList(_Strict):
    items: list[ProposalSummary]
    next_cursor: str | None


class ExecutionClaim(_Strict):
    """The proposal, now `executing`, and the engine commands the browser must submit."""

    proposal: ProposalDetail
    commands: list[dict[str, Any]]


class StrategyInfo(_Strict):
    id: str
    version: str
    objective: MetricKey
    description: str
    hard_constraints: list[str]


class AiStatus(_Strict):
    provider: Literal["none", "anthropic"]
    model: str | None
    configured: bool
    detail: str


class Capabilities(_Strict):
    strategies: list[StrategyInfo]
    ai: AiStatus
    execution: dict[str, Any]
    lifecycle: dict[str, list[str]]
    limits: dict[str, int]
