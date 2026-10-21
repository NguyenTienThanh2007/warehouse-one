"""Durable ingestion of simulation runs, command logs and domain events (DEC-024).

What the API validates (and rejects otherwise):
- every event against the domain-event contract (strict JSON semantics, Pydantic mirror);
- `event_id` equals the deterministic ID of `(simulation_id, sequence)`;
- `occurred_at` equals the run's simulated epoch + `simulation_time_ms`, a multiple of `tick_ms`;
- `sequence` is gap-free from the run's last stored sequence; simulated time never goes back;
- `aggregate_version` continues each aggregate's stored history by exactly +1;
- every command against the command contract; commands only for ticks not yet closed;
- batch size limits and idempotent retries (`batch_id`, identical overlapping events).

What it trusts: that the producer ran the TypeScript engine with the registered config and command
log. The API cannot re-simulate; `pnpm sim:verify` replays a stored run in the engine and compares
every event, which checks that trust after the fact.

Atomicity: one database transaction per batch. The run row is locked first, so batches of one run
are serialised; events, commands, outbox rows, the batch record and the run counters are committed
together or not at all.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import Connection, func, insert, select, tuple_, update

from warehouse_api.api.errors import ApiError
from warehouse_api.contracts.commands import COMMAND_ADAPTER
from warehouse_api.contracts.events import domain_event_adapter
from warehouse_api.contracts.identity import deterministic_uuid
from warehouse_api.ingest.canonical import canonical_json, sha256_hex, simulated_timestamp
from warehouse_api.store.tables import (
    command_log,
    domain_events,
    ingest_batches,
    outbox,
    simulation_runs,
)

MAX_EVENTS_PER_BATCH = 1000
MAX_COMMANDS_PER_BATCH = 500
RUN_SOURCES = ("web", "recorder", "test")


@dataclass(frozen=True)
class RunRegistration:
    simulation_id: UUID
    config: dict[str, Any]
    engine_version: str
    scenario_id: str | None
    source: str


@dataclass(frozen=True)
class BatchResult:
    batch_id: UUID
    simulation_id: UUID
    accepted_events: int
    duplicate_events: int
    accepted_commands: int
    duplicate_commands: int
    last_sequence: int
    through_tick: int
    replayed: bool


def _errors(exc: ValidationError) -> list[dict[str, Any]]:
    return [
        {"loc": [str(p) for p in e["loc"]], "msg": e["msg"], "type": e["type"]}
        for e in exc.errors()[:10]
    ]


# Runs -------------------------------------------------------------------------------------------


def register_run(conn: Connection, reg: RunRegistration) -> tuple[dict[str, Any], bool]:
    """Register a run idempotently. Returns (run, created). Conflicting re-registration is 409."""
    cfg = reg.config
    if str(cfg.get("simulation_id")) != str(reg.simulation_id):
        raise ApiError(422, "SIMULATION_MISMATCH", "config.simulation_id must equal the path id")
    seed, tick_ms, epoch_raw = cfg.get("seed"), cfg.get("tick_ms"), cfg.get("epoch")
    if not isinstance(seed, str) or not seed:
        raise ApiError(422, "INVALID_CONFIG", "config.seed must be a non-empty string")
    if not isinstance(tick_ms, int) or isinstance(tick_ms, bool) or tick_ms <= 0:
        raise ApiError(422, "INVALID_CONFIG", "config.tick_ms must be a positive integer")
    try:
        epoch = datetime.fromisoformat(str(epoch_raw))
    except ValueError:
        raise ApiError(422, "INVALID_CONFIG", "config.epoch must be an ISO-8601 time") from None
    if epoch.tzinfo is None:
        raise ApiError(422, "INVALID_CONFIG", "config.epoch must carry a UTC offset")
    if reg.source not in RUN_SOURCES:
        raise ApiError(422, "INVALID_SOURCE", f"source must be one of {RUN_SOURCES}")
    config_sha = sha256_hex(canonical_json(cfg))

    existing = (
        conn.execute(
            select(simulation_runs).where(simulation_runs.c.simulation_id == reg.simulation_id)
        )
        .mappings()
        .first()
    )
    if existing is not None:
        if existing["config_sha256"] != config_sha or existing["engine_version"] != (
            reg.engine_version
        ):
            raise ApiError(
                409,
                "RUN_CONFLICT",
                "a run with this simulation_id is registered with a different config or engine",
                {"simulation_id": str(reg.simulation_id)},
            )
        return dict(existing), False

    conn.execute(
        insert(simulation_runs).values(
            simulation_id=reg.simulation_id,
            scenario_id=reg.scenario_id,
            seed=seed,
            engine_version=reg.engine_version,
            tick_ms=tick_ms,
            epoch=epoch,
            config=cfg,
            config_sha256=config_sha,
            source=reg.source,
        )
    )
    row = (
        conn.execute(
            select(simulation_runs).where(simulation_runs.c.simulation_id == reg.simulation_id)
        )
        .mappings()
        .one()
    )
    return dict(row), True


# Batches ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Event:
    raw: dict[str, Any]
    canonical: bytes
    sha: str
    event_id: UUID
    sequence: int
    event_type: str
    schema_version: int
    aggregate_type: str
    aggregate_id: str
    aggregate_version: int
    occurred_at: datetime
    simulation_time_ms: int
    correlation_id: str
    causation_id: str
    payload: dict[str, Any]


@dataclass(frozen=True)
class _Command:
    command_id: str
    tick: int
    command_type: str
    command: dict[str, Any]
    sha: str


def _parse_events(
    simulation_id: UUID, run: dict[str, Any], events: list[dict[str, Any]]
) -> list[_Event]:
    parsed: list[_Event] = []
    tick_ms: int = run["tick_ms"]
    for index, raw in enumerate(events):
        canonical = canonical_json(raw)
        try:
            ev = domain_event_adapter.validate_json(canonical, strict=True)
        except ValidationError as exc:
            raise ApiError(
                422,
                "INVALID_EVENT",
                f"event {index} violates the event contract",
                {"index": index, "errors": _errors(exc)},
            ) from None
        details = {"index": index, "sequence": ev.sequence}
        if ev.simulation_id != simulation_id:
            raise ApiError(422, "SIMULATION_MISMATCH", "event belongs to another run", details)
        if str(ev.event_id) != deterministic_uuid(str(simulation_id), ev.sequence):
            raise ApiError(
                422,
                "EVENT_ID_MISMATCH",
                "event_id is not the deterministic id of (simulation_id, sequence)",
                details,
            )
        if ev.simulation_time_ms % tick_ms != 0:
            raise ApiError(
                422, "INVALID_SIMULATION_TIME", "simulation_time_ms is not a tick boundary", details
            )
        if raw.get("occurred_at") != simulated_timestamp(run["epoch"], ev.simulation_time_ms):
            raise ApiError(
                422,
                "INVALID_OCCURRED_AT",
                "occurred_at must equal the run epoch + simulation_time_ms (UTC, ms, Z)",
                details,
            )
        if parsed and ev.sequence != parsed[-1].sequence + 1:
            raise ApiError(
                422, "NON_CONTIGUOUS_BATCH", "event sequences in a batch must be +1 each", details
            )
        if parsed and ev.simulation_time_ms < parsed[-1].simulation_time_ms:
            raise ApiError(422, "TIME_REGRESSION", "simulated time went backwards", details)
        parsed.append(
            _Event(
                raw=raw,
                canonical=canonical,
                sha=sha256_hex(canonical),
                event_id=ev.event_id,
                sequence=ev.sequence,
                event_type=ev.event_type,
                schema_version=ev.schema_version,
                aggregate_type=ev.aggregate_type,
                aggregate_id=ev.aggregate_id,
                aggregate_version=ev.aggregate_version,
                occurred_at=ev.occurred_at,
                simulation_time_ms=ev.simulation_time_ms,
                correlation_id=ev.correlation_id,
                causation_id=ev.causation_id,
                payload=raw["payload"],
            )
        )
    return parsed


def _parse_commands(commands: list[dict[str, Any]], through_tick: int) -> list[_Command]:
    parsed: list[_Command] = []
    seen: set[str] = set()
    for index, record in enumerate(commands):
        tick = record.get("tick")
        if not isinstance(tick, int) or isinstance(tick, bool) or tick < 1 or tick > through_tick:
            raise ApiError(
                422,
                "INVALID_COMMAND",
                "command tick must be an integer in [1, through_tick]",
                {"index": index},
            )
        raw = record.get("command")
        try:
            cmd = COMMAND_ADAPTER.validate_json(canonical_json(raw), strict=True)
        except ValidationError as exc:
            raise ApiError(
                422,
                "INVALID_COMMAND",
                f"command {index} violates the command contract",
                {"index": index, "errors": _errors(exc)},
            ) from None
        if cmd.command_id in seen:
            raise ApiError(
                422, "DUPLICATE_COMMAND_ID", "command_id repeated in batch", {"index": index}
            )
        seen.add(cmd.command_id)
        if not isinstance(raw, dict):  # pragma: no cover - the contract check rejects non-objects
            raise ApiError(422, "INVALID_COMMAND", "command must be an object", {"index": index})
        parsed.append(
            _Command(
                command_id=cmd.command_id,
                tick=tick,
                command_type=cmd.type,
                command=raw,
                sha=sha256_hex(canonical_json({"tick": tick, "command": raw})),
            )
        )
    return parsed


def _batch_hash(
    through_tick: int, commands: list[dict[str, Any]], events: list[dict[str, Any]]
) -> str:
    return sha256_hex(
        canonical_json({"through_tick": through_tick, "commands": commands, "events": events})
    )


@dataclass(frozen=True)
class BatchRequest:
    simulation_id: UUID
    batch_id: UUID
    through_tick: int
    commands: list[dict[str, Any]]
    events: list[dict[str, Any]]


def ingest_batch(conn: Connection, req: BatchRequest, topic: str) -> BatchResult:
    """Validate and store one batch atomically (the caller owns the transaction)."""
    simulation_id, batch_id, through_tick = req.simulation_id, req.batch_id, req.through_tick
    commands, events = req.commands, req.events
    if len(events) > MAX_EVENTS_PER_BATCH or len(commands) > MAX_COMMANDS_PER_BATCH:
        raise ApiError(
            413,
            "BATCH_TOO_LARGE",
            f"at most {MAX_EVENTS_PER_BATCH} events and {MAX_COMMANDS_PER_BATCH} commands",
        )
    run_row = (
        conn.execute(
            select(simulation_runs)
            .where(simulation_runs.c.simulation_id == simulation_id)
            .with_for_update()
        )
        .mappings()
        .first()
    )
    if run_row is None:
        raise ApiError(404, "UNKNOWN_SIMULATION", "register the run before sending batches")
    run = dict(run_row)
    request_sha = _batch_hash(through_tick, commands, events)

    # Idempotent retry of a whole batch.
    prior = (
        conn.execute(select(ingest_batches).where(ingest_batches.c.batch_id == batch_id))
        .mappings()
        .first()
    )
    if prior is not None:
        if prior["simulation_id"] != simulation_id or prior["request_sha256"] != request_sha:
            raise ApiError(409, "BATCH_ID_REUSED", "batch_id was used for a different request")
        return BatchResult(
            batch_id=batch_id,
            simulation_id=simulation_id,
            accepted_events=prior["accepted_events"],
            duplicate_events=prior["duplicate_events"],
            accepted_commands=prior["accepted_commands"],
            duplicate_commands=prior["duplicate_commands"],
            last_sequence=run["last_sequence"],
            through_tick=run["through_tick"],
            replayed=True,
        )

    if through_tick < run["through_tick"]:
        raise ApiError(
            409,
            "THROUGH_TICK_REGRESSION",
            "through_tick is behind what the run already recorded",
            {"recorded_through_tick": run["through_tick"]},
        )
    parsed = _parse_events(simulation_id, run, events)
    cmds = _parse_commands(commands, through_tick)
    if parsed and parsed[-1].simulation_time_ms // run["tick_ms"] > through_tick:
        raise ApiError(422, "THROUGH_TICK_TOO_LOW", "events are later than through_tick")

    new_events = _drop_identical_overlap(conn, simulation_id, run["last_sequence"], parsed)
    duplicate_events = len(parsed) - len(new_events)
    if new_events:
        if new_events[0].sequence != run["last_sequence"] + 1:
            raise ApiError(
                409,
                "SEQUENCE_GAP",
                "events must continue the run's sequence without gaps",
                {"expected_sequence": run["last_sequence"] + 1, "got": new_events[0].sequence},
            )
        if new_events[0].simulation_time_ms < run["last_simulation_time_ms"]:
            raise ApiError(409, "TIME_REGRESSION", "simulated time went backwards")
        _check_aggregate_versions(conn, simulation_id, new_events)

    new_cmds = _drop_identical_commands(conn, simulation_id, cmds, run["through_tick"])
    duplicate_commands = len(cmds) - len(new_cmds)

    conn.execute(
        insert(ingest_batches).values(
            batch_id=batch_id,
            simulation_id=simulation_id,
            request_sha256=request_sha,
            first_sequence=new_events[0].sequence if new_events else None,
            last_sequence=new_events[-1].sequence if new_events else None,
            through_tick=through_tick,
            accepted_events=len(new_events),
            duplicate_events=duplicate_events,
            accepted_commands=len(new_cmds),
            duplicate_commands=duplicate_commands,
        )
    )
    if new_cmds:
        conn.execute(
            insert(command_log),
            [
                {
                    "simulation_id": simulation_id,
                    "command_id": c.command_id,
                    "log_index": run["command_count"] + i,
                    "tick": c.tick,
                    "command_type": c.command_type,
                    "command": c.command,
                    "command_sha256": c.sha,
                    "batch_id": batch_id,
                }
                for i, c in enumerate(new_cmds)
            ],
        )
    if new_events:
        conn.execute(
            insert(domain_events),
            [
                {
                    "event_id": e.event_id,
                    "simulation_id": simulation_id,
                    "sequence": e.sequence,
                    "event_type": e.event_type,
                    "schema_version": e.schema_version,
                    "aggregate_type": e.aggregate_type,
                    "aggregate_id": e.aggregate_id,
                    "aggregate_version": e.aggregate_version,
                    "occurred_at": e.occurred_at,
                    "simulation_time_ms": e.simulation_time_ms,
                    "correlation_id": e.correlation_id,
                    "causation_id": e.causation_id,
                    "payload": e.payload,
                    "envelope": e.raw,
                    "envelope_sha256": e.sha,
                    "batch_id": batch_id,
                }
                for e in new_events
            ],
        )
        insert_outbox(conn, simulation_id, new_events, topic)

    last = new_events[-1] if new_events else None
    conn.execute(
        update(simulation_runs)
        .where(simulation_runs.c.simulation_id == simulation_id)
        .values(
            last_sequence=last.sequence if last else run["last_sequence"],
            last_simulation_time_ms=last.simulation_time_ms
            if last
            else run["last_simulation_time_ms"],
            through_tick=through_tick,
            event_count=simulation_runs.c.event_count + len(new_events),
            command_count=simulation_runs.c.command_count + len(new_cmds),
        )
    )
    return BatchResult(
        batch_id=batch_id,
        simulation_id=simulation_id,
        accepted_events=len(new_events),
        duplicate_events=duplicate_events,
        accepted_commands=len(new_cmds),
        duplicate_commands=duplicate_commands,
        last_sequence=last.sequence if last else run["last_sequence"],
        through_tick=through_tick,
        replayed=False,
    )


def insert_outbox(conn: Connection, simulation_id: UUID, events: list[_Event], topic: str) -> None:
    """One outbox row per new event, in the same transaction as the event itself."""
    conn.execute(
        insert(outbox),
        [
            {
                "event_id": e.event_id,
                "simulation_id": simulation_id,
                "sequence": e.sequence,
                "topic": topic,
                "message_key": str(simulation_id),
                "message_value": e.canonical,
                "headers": {
                    "event_id": str(e.event_id),
                    "event_type": e.event_type,
                    "schema_version": str(e.schema_version),
                    "content-type": "application/json",
                },
            }
            for e in events
        ],
    )


def _drop_identical_overlap(
    conn: Connection, simulation_id: UUID, last_sequence: int, parsed: list[_Event]
) -> list[_Event]:
    """Events already stored are accepted as duplicates only if byte-identical; else 409."""
    overlap = [e for e in parsed if e.sequence <= last_sequence]
    if not overlap:
        return parsed
    rows = conn.execute(
        select(domain_events.c.sequence, domain_events.c.envelope_sha256).where(
            domain_events.c.simulation_id == simulation_id,
            domain_events.c.sequence.between(overlap[0].sequence, overlap[-1].sequence),
        )
    )
    stored = {key: sha for key, sha in rows}
    for e in overlap:
        if stored.get(e.sequence) != e.sha:
            raise ApiError(
                409,
                "CONFLICTING_EVENT",
                "an event with this sequence is stored with different content",
                {"sequence": e.sequence, "event_id": str(e.event_id)},
            )
    return [e for e in parsed if e.sequence > last_sequence]


def _check_aggregate_versions(conn: Connection, simulation_id: UUID, events: list[_Event]) -> None:
    keys = sorted({(e.aggregate_type, e.aggregate_id) for e in events})
    stored: dict[tuple[str, str], int] = defaultdict(int)
    for agg_type, agg_id, version in conn.execute(
        select(
            domain_events.c.aggregate_type,
            domain_events.c.aggregate_id,
            func.max(domain_events.c.aggregate_version),
        )
        .where(
            domain_events.c.simulation_id == simulation_id,
            tuple_(domain_events.c.aggregate_type, domain_events.c.aggregate_id).in_(keys),
        )
        .group_by(domain_events.c.aggregate_type, domain_events.c.aggregate_id)
    ):
        stored[(agg_type, agg_id)] = int(version)
    for e in events:
        key = (e.aggregate_type, e.aggregate_id)
        expected = stored[key] + 1
        if e.aggregate_version != expected:
            raise ApiError(
                409,
                "AGGREGATE_VERSION_GAP"
                if e.aggregate_version > expected
                else "AGGREGATE_VERSION_REGRESSION",
                "aggregate_version must continue the aggregate's history by +1",
                {
                    "sequence": e.sequence,
                    "aggregate": f"{e.aggregate_type}/{e.aggregate_id}",
                    "expected_version": expected,
                    "got": e.aggregate_version,
                },
            )
        stored[key] = e.aggregate_version


def _drop_identical_commands(
    conn: Connection, simulation_id: UUID, cmds: list[_Command], closed_through: int
) -> list[_Command]:
    if not cmds:
        return []
    rows = conn.execute(
        select(command_log.c.command_id, command_log.c.command_sha256).where(
            command_log.c.simulation_id == simulation_id,
            command_log.c.command_id.in_([c.command_id for c in cmds]),
        )
    )
    stored = {key: sha for key, sha in rows}
    fresh: list[_Command] = []
    for c in cmds:
        if c.command_id in stored:
            if stored[c.command_id] != c.sha:
                raise ApiError(
                    409,
                    "CONFLICTING_COMMAND",
                    "a command with this command_id is stored with different content",
                    {"command_id": c.command_id},
                )
            continue
        if c.tick <= closed_through:
            raise ApiError(
                409,
                "COMMAND_TICK_CLOSED",
                "commands cannot be added to ticks the run has already recorded",
                {
                    "command_id": c.command_id,
                    "tick": c.tick,
                    "recorded_through_tick": closed_through,
                },
            )
        fresh.append(c)
    return fresh


# Reads ------------------------------------------------------------------------------------------


def run_status(conn: Connection, simulation_id: UUID) -> dict[str, Any]:
    row = (
        conn.execute(
            select(simulation_runs).where(simulation_runs.c.simulation_id == simulation_id)
        )
        .mappings()
        .first()
    )
    if row is None:
        raise ApiError(404, "UNKNOWN_SIMULATION", "no run with this simulation_id")
    pending, published, failing = conn.execute(
        select(
            func.count().filter(outbox.c.published_at.is_(None)),
            func.count().filter(outbox.c.published_at.is_not(None)),
            func.count().filter(outbox.c.published_at.is_(None), outbox.c.attempts > 0),
        ).where(outbox.c.simulation_id == simulation_id)
    ).one()
    run = dict(row)
    return {
        "simulation_id": str(run["simulation_id"]),
        "scenario_id": run["scenario_id"],
        "seed": run["seed"],
        "engine_version": run["engine_version"],
        "tick_ms": run["tick_ms"],
        "epoch": run["epoch"].isoformat(),
        "source": run["source"],
        "registered_at": run["registered_at"].isoformat(),
        "config": run["config"],
        "last_sequence": run["last_sequence"],
        "through_tick": run["through_tick"],
        "event_count": run["event_count"],
        "command_count": run["command_count"],
        "outbox": {"pending": pending, "published": published, "failing": failing},
        "relay": {
            "failures": run["relay_failures"],
            "last_error": run["relay_last_error"],
            "next_attempt_at": run["relay_next_attempt_at"].isoformat()
            if run["relay_next_attempt_at"]
            else None,
        },
    }


def list_commands(conn: Connection, simulation_id: UUID) -> list[dict[str, Any]]:
    rows = conn.execute(
        select(command_log.c.tick, command_log.c.command)
        .where(command_log.c.simulation_id == simulation_id)
        .order_by(command_log.c.log_index)
    )
    return [{"tick": tick, "command": cmd} for tick, cmd in rows]


def list_events(
    conn: Connection, simulation_id: UUID, after_sequence: int, limit: int
) -> list[dict[str, Any]]:
    rows = conn.execute(
        select(domain_events.c.envelope)
        .where(
            domain_events.c.simulation_id == simulation_id,
            domain_events.c.sequence > after_sequence,
        )
        .order_by(domain_events.c.sequence)
        .limit(limit)
    ).scalars()
    return [dict(e) for e in rows]
