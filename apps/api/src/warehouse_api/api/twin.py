"""Digital-twin API (Phase 6, DEC-039..041): fleet-standby proposals, their review, execution
bookkeeping and AI explanations.

What-if evaluations run in the TypeScript engine (packages/twin), in the browser or with
`pnpm twin:verify`; the server never simulates. It validates what it is given against the stored
snapshot, owns the lifecycle and records who decided what. Actors are named, not authenticated:
authentication arrives with Phase 7, like for every other endpoint.
"""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import Engine

from warehouse_api.config import Settings, get_settings
from warehouse_api.db import get_engine
from warehouse_api.twin import ai, rules, service
from warehouse_api.twin.schemas import (
    Capabilities,
    DecisionRequest,
    ExecutionClaim,
    ExecutionReport,
    ExecutionRequest,
    Explanation,
    ProposalCreate,
    ProposalDetail,
    ProposalList,
    ProposalStatus,
    StrategyInfo,
)

router = APIRouter(prefix="/api/v1/twin", tags=["digital twin"])

EngineDep = Annotated[Engine, Depends(get_engine)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
ERRORS: dict[int | str, dict[str, Any]] = {404: {}, 409: {}, 422: {}}


def get_provider(settings: SettingsDep) -> ai.Provider | None:
    return ai.provider_for(settings)


@router.get("/capabilities", response_model=Capabilities)
def capabilities(settings: SettingsDep) -> Capabilities:
    """What the twin can do here: strategies, AI availability, execution path and limits.
    Never includes credentials."""
    return Capabilities(
        strategies=[
            StrategyInfo(
                id="fleet-standby",
                version="1.0.0",
                objective="pickup_wait_s",
                description="Where idle line-haul trucks wait between jobs. Candidate plans are "
                "simulated from a frozen snapshot of the live run by the simulation engine and "
                "compared with the plan in effect.",
                hard_constraints=[
                    "Every truck of the fleet exactly once",
                    "Standby only at sites with staging stalls",
                    "One staging stall per site always stays free",
                    "The engine accepts every standby command",
                    "Engine invariants hold for the whole horizon",
                    "Service level: at least the configured share of the baseline's pallets",
                    "No more cancelled transfers than the baseline",
                ],
            )
        ],
        ai=ai.ai_status(settings),
        execution={
            "supported": True,
            "command": "linehaul.set_standby",
            "path": "The browser submits the approved commands to the live simulation runner, "
            "which validates them like any operator command, and reports the result here.",
        },
        lifecycle={k: list(v) for k, v in rules.TRANSITIONS.items()},
        limits={
            "max_age_ticks": settings.twin_max_age_ticks,
            "max_explanations_per_proposal": settings.ai_max_explanations_per_proposal,
            "max_page": service.MAX_PAGE,
            "max_request_bytes": settings.max_request_bytes,
        },
    )


@router.post(
    "/proposals",
    response_model=ProposalDetail,
    status_code=201,
    responses={200: {"description": "Already stored (same evaluation id)"}, 422: {}},
)
def create_proposal(
    body: ProposalCreate, response: Response, engine: EngineDep, settings: SettingsDep
) -> ProposalDetail:
    """Store an evaluation with its input snapshot. The server re-validates it: the result is
    `validated` (actionable), `not_actionable` (nothing beat the baseline) or `invalid` (a check
    failed; see `validation`). Posting the same evaluation again returns the stored proposal."""
    proposal, created = service.create(engine, body, settings)
    if not created:
        response.status_code = 200
    return proposal


@router.get("/proposals", response_model=ProposalList, responses={422: {}})
def list_proposals(
    engine: EngineDep,
    limit: Annotated[int, Query(ge=1, le=service.MAX_PAGE)] = 20,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
    status: ProposalStatus | None = None,
    simulation_id: UUID | None = None,
) -> ProposalList:
    """Newest first, `limit` at a time; pass `next_cursor` back as `cursor` for the next page."""
    with engine.connect() as conn:
        return service.list_proposals(conn, limit, cursor, status, simulation_id)


@router.get("/proposals/{proposal_id}", response_model=ProposalDetail, responses=ERRORS)
def get_proposal(proposal_id: UUID, engine: EngineDep, settings: SettingsDep) -> ProposalDetail:
    """A proposal with its evaluation, server validation, commands, audit history and AI
    explanations."""
    with engine.connect() as conn:
        return service.detail(conn, proposal_id, settings)


@router.get("/proposals/{proposal_id}/snapshot", responses=ERRORS)
def get_snapshot(proposal_id: UUID, engine: EngineDep) -> dict[str, Any]:
    """The frozen input snapshot, to re-run the evaluation (`pnpm twin:verify`)."""
    with engine.connect() as conn:
        return service.snapshot(conn, proposal_id)


@router.post("/proposals/{proposal_id}/decision", response_model=ProposalDetail, responses=ERRORS)
def decide(
    proposal_id: UUID, body: DecisionRequest, engine: EngineDep, settings: SettingsDep
) -> ProposalDetail:
    """Approve or reject. Approving checks the proposal against the live run first (stale →
    `expired`, 409 STALE_PROPOSAL). Repeating a decision is idempotent; contradicting one is 409."""
    return service.decide(engine, proposal_id, body, settings)


@router.post("/proposals/{proposal_id}/execution", response_model=ExecutionClaim, responses=ERRORS)
def claim_execution(
    proposal_id: UUID, body: ExecutionRequest, engine: EngineDep, settings: SettingsDep
) -> ExecutionClaim:
    """Start executing an approved, still-fresh proposal: it becomes `executing` (exactly once)
    and the response carries the engine commands to submit."""
    return service.claim_execution(engine, proposal_id, body, settings)


@router.post(
    "/proposals/{proposal_id}/execution/result", response_model=ProposalDetail, responses=ERRORS
)
def report_execution(
    proposal_id: UUID, body: ExecutionReport, engine: EngineDep, settings: SettingsDep
) -> ProposalDetail:
    """What the engine did with the commands: `applied` only if it accepted every one."""
    return service.report_execution(engine, proposal_id, body, settings)


@router.post(
    "/proposals/{proposal_id}/explanations",
    response_model=Explanation,
    status_code=201,
    responses={**ERRORS, 429: {}, 502: {}, 503: {}, 504: {}},
)
def explain(
    proposal_id: UUID,
    engine: EngineDep,
    settings: SettingsDep,
    provider: Annotated[ai.Provider | None, Depends(get_provider)],
) -> Explanation:
    """Ask the configured AI provider to explain the proposal. The answer is AI-generated prose,
    validated against a schema and checked against the stored figures; failures are recorded and
    answered with a stable error code (503 AI_NOT_CONFIGURED when no provider is set)."""
    return service.request_explanation(engine, proposal_id, settings, provider)
