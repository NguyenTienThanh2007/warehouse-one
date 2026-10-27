"""Persistence and lifecycle of digital-twin proposals (Phase 6, DEC-040).

Every status change happens in one transaction that locks the proposal row (`FOR UPDATE`), bumps
its `version` and appends an audit event, so concurrent requests serialise: the second approval of
the same proposal sees it approved and answers idempotently instead of recording it twice, and an
execution can be claimed exactly once.
"""

import base64
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import Connection, Engine, RowMapping, and_, func, insert, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from warehouse_api.api.errors import ApiError
from warehouse_api.config import Settings
from warehouse_api.store.tables import twin_explanations as tx
from warehouse_api.store.tables import twin_proposal_events as te
from warehouse_api.store.tables import twin_proposals as tp
from warehouse_api.twin import ai, rules
from warehouse_api.twin.schemas import (
    AuditEntry,
    DecisionRequest,
    Evaluation,
    ExecutionClaim,
    ExecutionReport,
    ExecutionRequest,
    Explanation,
    ObjectiveSummary,
    ProposalCreate,
    ProposalDetail,
    ProposalList,
    ProposalSummary,
    ValidationCheck,
)

SYSTEM_ACTOR = "system:twin"
MAX_PAGE = 50

# Columns for reads that do not need the (large) input snapshot.
_COLUMNS = [c for c in tp.c if c.name != "input_snapshot"]


def _not_found(proposal_id: UUID) -> ApiError:
    return ApiError(404, "PROPOSAL_NOT_FOUND", f"no proposal {proposal_id}")


@dataclass(frozen=True)
class Step:
    """Who did what, for the audit trail."""

    action: str
    actor: str
    note: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


def _audit(
    conn: Connection, proposal_id: UUID, from_status: str | None, to_status: str, step: Step
) -> None:
    conn.execute(
        insert(te).values(
            proposal_id=proposal_id,
            action=step.action,
            from_status=from_status,
            to_status=to_status,
            actor=step.actor,
            note=step.note,
            details=step.details,
        )
    )


def _transition(
    conn: Connection, row: RowMapping, to_status: str, step: Step, **values: Any
) -> None:
    if not rules.can_transition(row["status"], to_status):  # pragma: no cover - callers check
        raise ApiError(409, "INVALID_TRANSITION", f"{row['status']} → {to_status} is not allowed")
    conn.execute(
        update(tp)
        .where(tp.c.proposal_id == row["proposal_id"], tp.c.version == row["version"])
        .values(status=to_status, version=row["version"] + 1, updated_at=func.now(), **values)
    )
    _audit(conn, row["proposal_id"], row["status"], to_status, step)


def _locked(conn: Connection, proposal_id: UUID) -> RowMapping:
    row = (
        conn.execute(select(*_COLUMNS).where(tp.c.proposal_id == proposal_id).with_for_update())
        .mappings()
        .first()
    )
    if row is None:
        raise _not_found(proposal_id)
    return row


# ---------------------------------------------------------------------------------------------
# Reads


def _objective(evaluation: dict[str, Any]) -> ObjectiveSummary:
    rec = evaluation.get("recommendation")
    rec_id = rec["candidate_id"] if rec else None
    chosen = next((c for c in evaluation["candidates"] if c["candidate_id"] == rec_id), None)
    if chosen is None:
        ranked = [c for c in evaluation["candidates"] if c.get("rank") == 1]
        chosen = ranked[0] if ranked else None
    delta = next(
        (d for d in (chosen or {}).get("deltas", []) if d["key"] == rules.PRIMARY_METRIC), None
    )
    return ObjectiveSummary(
        metric=rules.PRIMARY_METRIC,
        baseline=evaluation["baseline"]["metrics"][rules.PRIMARY_METRIC],
        candidate=delta["candidate"] if delta else None,
        pct=delta["pct"] if delta else None,
    )


def _summary(row: RowMapping) -> ProposalSummary:
    e = row["evaluation"]
    rec = e.get("recommendation")
    return ProposalSummary(
        proposal_id=row["proposal_id"],
        evaluation_id=row["evaluation_id"],
        kind=row["kind"],
        status=row["status"],
        version=row["version"],
        strategy={"id": row["strategy_id"], "version": row["strategy_version"]},
        simulation_id=row["simulation_id"],
        source_tick=row["source_tick"],
        source_business_time=row["source_business_time"],
        headline=rec["summary"] if rec else (e.get("no_recommendation_reason") or ""),
        objective=_objective(e),
        recommended_candidate_id=row["recommended_candidate_id"],
        created_by=row["created_by"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        decided_by=row["decided_by"],
        decided_at=row["decided_at"],
    )


def _explanation(r: RowMapping) -> Explanation:
    return Explanation(
        explanation_id=r["explanation_id"],
        status=r["status"],
        provider=r["provider"],
        model=r["model"],
        prompt_version=r["prompt_version"],
        content=r["content"],
        error_code=r["error_code"],
        error_message=r["error_message"],
        latency_ms=r["latency_ms"],
        created_at=r["created_at"],
    )


def detail(conn: Connection, proposal_id: UUID, settings: Settings) -> ProposalDetail:
    row = conn.execute(select(*_COLUMNS).where(tp.c.proposal_id == proposal_id)).mappings().first()
    if row is None:
        raise _not_found(proposal_id)
    history = conn.execute(
        select(te).where(te.c.proposal_id == proposal_id).order_by(te.c.event_id)
    ).mappings()
    explanations = conn.execute(
        select(tx).where(tx.c.proposal_id == proposal_id).order_by(tx.c.created_at)
    ).mappings()
    return ProposalDetail(
        **_summary(row).model_dump(),
        evaluation=Evaluation.model_validate(row["evaluation"]),
        validation=[ValidationCheck.model_validate(v) for v in row["validation"]],
        commands=row["commands"],
        history=[
            AuditEntry(
                action=h["action"],
                from_status=h["from_status"],
                to_status=h["to_status"],
                actor=h["actor"],
                note=h["note"],
                details=h["details"],
                recorded_at=h["recorded_at"],
            )
            for h in history
        ],
        explanations=[_explanation(x) for x in explanations],
        decision_note=row["decision_note"],
        executed_tick=row["executed_tick"],
        max_age_ticks=settings.twin_max_age_ticks,
    )


def _encode_cursor(created_at: datetime, proposal_id: UUID) -> str:
    raw = f"{created_at.isoformat()}|{proposal_id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        at, pid = raw.split("|")
        return datetime.fromisoformat(at), UUID(pid)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(422, "INVALID_CURSOR", "the cursor is not one this API returned") from exc


def list_proposals(
    conn: Connection,
    limit: int,
    cursor: str | None,
    status: str | None,
    simulation_id: UUID | None,
) -> ProposalList:
    q = select(*_COLUMNS).order_by(tp.c.created_at.desc(), tp.c.proposal_id.desc())
    if status:
        q = q.where(tp.c.status == status)
    if simulation_id:
        q = q.where(tp.c.simulation_id == simulation_id)
    if cursor:
        at, pid = _decode_cursor(cursor)
        q = q.where(or_(tp.c.created_at < at, and_(tp.c.created_at == at, tp.c.proposal_id < pid)))
    rows = list(conn.execute(q.limit(limit + 1)).mappings())
    more = len(rows) > limit
    rows = rows[:limit]
    return ProposalList(
        items=[_summary(r) for r in rows],
        next_cursor=_encode_cursor(rows[-1]["created_at"], rows[-1]["proposal_id"])
        if more
        else None,
    )


def snapshot(conn: Connection, proposal_id: UUID) -> dict[str, Any]:
    value = conn.execute(
        select(tp.c.input_snapshot).where(tp.c.proposal_id == proposal_id)
    ).scalar_one_or_none()
    if value is None:
        raise _not_found(proposal_id)
    result: dict[str, Any] = value
    return result


# ---------------------------------------------------------------------------------------------
# Writes


def create(engine: Engine, body: ProposalCreate, settings: Settings) -> tuple[ProposalDetail, bool]:
    """Store an evaluation as a proposal. Idempotent by evaluation id: (proposal, created?)."""
    proposal_id = uuid.uuid4()
    checked = rules.validate(body.evaluation, body.snapshot, prefix=f"twin-{proposal_id.hex[:8]}")
    e = checked.evaluation
    with engine.begin() as conn:
        inserted = conn.execute(
            pg_insert(tp)
            .values(
                proposal_id=proposal_id,
                evaluation_id=e.evaluation_id,
                kind=e.kind,
                strategy_id=e.strategy.id,
                strategy_version=e.strategy.version,
                status=checked.status,
                version=1,
                simulation_id=e.source.simulation_id,
                source_tick=e.source.tick,
                source_business_time=datetime.fromisoformat(e.source.simulated_at),
                source_state_hash=e.source.state_hash,
                config_hash=e.source.config_hash,
                fleet_fingerprint=e.source.fleet_fingerprint,
                objective_metric=e.objective.metric,
                recommended_candidate_id=e.recommendation.candidate_id
                if e.recommendation and checked.status == "validated"
                else None,
                evaluation=e.model_dump(mode="json", by_alias=True),
                validation=[c.model_dump() for c in checked.checks],
                commands=checked.commands,
                input_snapshot=body.snapshot.model_dump(mode="json"),
                created_by=body.created_by,
            )
            .on_conflict_do_nothing(index_elements=[tp.c.evaluation_id])
            .returning(tp.c.proposal_id)
        ).scalar_one_or_none()
        if inserted is None:
            existing = conn.execute(
                select(tp.c.proposal_id).where(tp.c.evaluation_id == e.evaluation_id)
            ).scalar_one()
            return detail(conn, existing, settings), False
        _audit(conn, proposal_id, None, "generated", Step("created", body.created_by))
        failed = [c.id for c in checked.checks if not c.passed]
        _audit(
            conn,
            proposal_id,
            "generated",
            checked.status,
            Step(
                "validation",
                SYSTEM_ACTOR,
                details={"failed_checks": failed} if failed else {},
            ),
        )
        if checked.status == "validated":
            # A newer proposal for the same run replaces any older one still awaiting a decision.
            older = conn.execute(
                select(*_COLUMNS)
                .where(
                    tp.c.simulation_id == e.source.simulation_id,
                    tp.c.status == "validated",
                    tp.c.proposal_id != proposal_id,
                )
                .with_for_update()
            ).mappings()
            for row in list(older):
                _transition(
                    conn,
                    row,
                    "superseded",
                    Step("superseded", SYSTEM_ACTOR, details={"by": str(proposal_id)}),
                )
        return detail(conn, proposal_id, settings), True


def decide(
    engine: Engine, proposal_id: UUID, req: DecisionRequest, settings: Settings
) -> ProposalDetail:
    deferred: ApiError | None = None
    with engine.begin() as conn:
        row = _locked(conn, proposal_id)
        if req.expected_version is not None and req.expected_version != row["version"]:
            raise ApiError(
                409,
                "VERSION_CONFLICT",
                f"the proposal changed (version {row['version']}, expected "
                f"{req.expected_version}); reload it and decide again",
                {"status": row["status"], "version": row["version"]},
            )
        target = "approved" if req.decision == "approve" else "rejected"
        if row["status"] == target:
            return detail(conn, proposal_id, settings)  # idempotent repeat: nothing recorded
        if not rules.can_transition(row["status"], target):
            raise ApiError(
                409,
                "INVALID_TRANSITION",
                f"a proposal that is {row['status']} cannot be {target}",
                {"status": row["status"]},
            )
        if target == "approved":
            if req.context is None:
                raise ApiError(
                    422, "CONTEXT_REQUIRED", "approval needs the live run's context to check it"
                )
            stale = rules.staleness(dict(row), req.context, settings.twin_max_age_ticks)
            if stale:
                _transition(
                    conn,
                    row,
                    "expired",
                    Step(
                        "expired",
                        req.actor,
                        details={"reason": stale.reason, "live_tick": req.context.tick},
                    ),
                )
                deferred = ApiError(409, "STALE_PROPOSAL", stale.message, {"reason": stale.reason})
        if deferred is None:
            _transition(
                conn,
                row,
                target,
                Step(
                    req.decision,
                    req.actor,
                    req.note,
                    {"live_tick": req.context.tick} if req.context else {},
                ),
                decided_by=req.actor,
                decided_at=func.now(),
                decision_note=req.note,
            )
            return detail(conn, proposal_id, settings)
    raise deferred  # the expiry above is committed first


def claim_execution(
    engine: Engine, proposal_id: UUID, req: ExecutionRequest, settings: Settings
) -> ExecutionClaim:
    deferred: ApiError | None = None
    with engine.begin() as conn:
        row = _locked(conn, proposal_id)
        if req.expected_version is not None and req.expected_version != row["version"]:
            raise ApiError(
                409,
                "VERSION_CONFLICT",
                f"the proposal changed (version {row['version']}); reload it",
                {"status": row["status"], "version": row["version"]},
            )
        if row["status"] in ("executing", "applied", "failed"):
            raise ApiError(
                409,
                "ALREADY_EXECUTED",
                f"this proposal was already executed ({row['status']}); it is never applied twice",
                {"status": row["status"]},
            )
        if row["status"] != "approved":
            raise ApiError(
                409,
                "NOT_APPROVED",
                f"only an approved proposal can be executed; this one is {row['status']}",
                {"status": row["status"]},
            )
        stale = rules.staleness(dict(row), req.context, settings.twin_max_age_ticks)
        if stale:
            _transition(
                conn,
                row,
                "expired",
                Step(
                    "expired",
                    req.actor,
                    details={"reason": stale.reason, "live_tick": req.context.tick},
                ),
            )
            deferred = ApiError(409, "STALE_PROPOSAL", stale.message, {"reason": stale.reason})
        else:
            _transition(
                conn,
                row,
                "executing",
                Step(
                    "execute",
                    req.actor,
                    details={"live_tick": req.context.tick, "commands": len(row["commands"])},
                ),
            )
            return ExecutionClaim(
                proposal=detail(conn, proposal_id, settings), commands=row["commands"]
            )
    raise deferred


def report_execution(
    engine: Engine, proposal_id: UUID, req: ExecutionReport, settings: Settings
) -> ProposalDetail:
    with engine.begin() as conn:
        row = _locked(conn, proposal_id)
        if row["status"] == req.outcome:
            return detail(conn, proposal_id, settings)  # the same report twice
        if row["status"] != "executing":
            raise ApiError(
                409,
                "NOT_EXECUTING",
                f"no execution is in progress (status {row['status']})",
                {"status": row["status"]},
            )
        issued = [c["command_id"] for c in row["commands"]]
        reported = {r.command_id: r for r in req.results}
        if req.outcome == "applied" and (
            sorted(reported) != sorted(issued) or not all(r.accepted for r in req.results)
        ):
            raise ApiError(
                422,
                "INCONSISTENT_RESULT",
                "'applied' needs every issued command, each accepted by the engine; "
                "report 'failed' otherwise",
                {"issued": issued},
            )
        _transition(
            conn,
            row,
            req.outcome,
            Step(
                req.outcome, req.actor, req.note, {"results": [r.model_dump() for r in req.results]}
            ),
            executed_tick=req.applied_tick,
        )
        return detail(conn, proposal_id, settings)


def request_explanation(
    engine: Engine, proposal_id: UUID, settings: Settings, provider: ai.Provider | None
) -> Explanation:
    if provider is None:
        status = ai.ai_status(settings)
        raise ApiError(503, "AI_NOT_CONFIGURED", status.detail, {"provider": status.provider})
    with engine.connect() as conn:
        row = (
            conn.execute(select(*_COLUMNS).where(tp.c.proposal_id == proposal_id))
            .mappings()
            .first()
        )
        if row is None:
            raise _not_found(proposal_id)
        used = conn.execute(
            select(func.count()).select_from(tx).where(tx.c.proposal_id == proposal_id)
        ).scalar_one()
    if used >= settings.ai_max_explanations_per_proposal:
        raise ApiError(
            429,
            "EXPLANATION_LIMIT",
            f"this proposal already has {used} explanation requests "
            f"(limit {settings.ai_max_explanations_per_proposal})",
        )
    # No transaction is held while the provider answers.
    outcome = ai.explain(provider, dict(row))
    explanation_id = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            insert(tx).values(
                explanation_id=explanation_id,
                proposal_id=proposal_id,
                status="ok" if outcome.ok else "failed",
                provider=outcome.provider,
                model=outcome.model,
                prompt_version=ai.PROMPT_VERSION,
                content=outcome.content.model_dump() if outcome.content else None,
                error_code=outcome.error.code if outcome.error else None,
                error_message=outcome.error.message if outcome.error else None,
                latency_ms=outcome.latency_ms,
                input_tokens=outcome.input_tokens,
                output_tokens=outcome.output_tokens,
            )
        )
        stored = (
            conn.execute(select(tx).where(tx.c.explanation_id == explanation_id)).mappings().one()
        )
    if outcome.error:
        details: dict[str, Any] = {"explanation_id": str(explanation_id)}
        if outcome.error.retry_after_s is not None:
            details["retry_after_s"] = outcome.error.retry_after_s
        raise ApiError(outcome.error.status, outcome.error.code, outcome.error.message, details)
    return _explanation(stored)
