"""Operational ingestion API: simulation runs, command logs and domain events (DEC-024)."""

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Engine

from warehouse_api.config import Settings, get_settings
from warehouse_api.db import get_engine
from warehouse_api.ingest.service import (
    MAX_COMMANDS_PER_BATCH,
    MAX_EVENTS_PER_BATCH,
    BatchRequest,
    RunRegistration,
    ingest_batch,
    list_commands,
    list_events,
    register_run,
    run_status,
)

router = APIRouter(prefix="/api/v1/simulations", tags=["simulations"])

MAX_EVENTS_PER_PAGE = 5000


class RegisterRunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    config: dict[str, Any]
    engine_version: Annotated[str, Field(min_length=1, max_length=32)]
    scenario_id: Annotated[str | None, Field(max_length=64)] = None
    source: Literal["web", "recorder", "test"]


class RunOut(BaseModel):
    simulation_id: UUID
    created: bool
    last_sequence: int
    through_tick: int


class BatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    batch_id: UUID
    through_tick: Annotated[int, Field(ge=0)]
    commands: Annotated[list[dict[str, Any]], Field(max_length=MAX_COMMANDS_PER_BATCH)] = []
    events: Annotated[list[dict[str, Any]], Field(max_length=MAX_EVENTS_PER_BATCH)] = []


class BatchOut(BaseModel):
    batch_id: UUID
    simulation_id: UUID
    accepted_events: int
    duplicate_events: int
    accepted_commands: int
    duplicate_commands: int
    last_sequence: int
    through_tick: int
    replayed: bool


class EventsPage(BaseModel):
    simulation_id: UUID
    events: list[dict[str, Any]]
    next_after_sequence: int | None


@router.put(
    "/{simulation_id}",
    response_model=RunOut,
    responses={201: {"model": RunOut}, 409: {}, 422: {}},
)
def put_run(
    simulation_id: UUID,
    body: RegisterRunIn,
    response: Response,
    engine: Annotated[Engine, Depends(get_engine)],
) -> RunOut:
    """Register a run (idempotent). Re-registering with a different config is a 409."""
    with engine.begin() as conn:
        run, created = register_run(
            conn,
            RunRegistration(
                simulation_id=simulation_id,
                config=body.config,
                engine_version=body.engine_version,
                scenario_id=body.scenario_id,
                source=body.source,
            ),
        )
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return RunOut(
        simulation_id=simulation_id,
        created=created,
        last_sequence=run["last_sequence"],
        through_tick=run["through_tick"],
    )


@router.post(
    "/{simulation_id}/batches",
    response_model=BatchOut,
    responses={200: {"model": BatchOut}, 404: {}, 409: {}, 413: {}, 422: {}},
    status_code=status.HTTP_201_CREATED,
)
def post_batch(
    simulation_id: UUID,
    body: BatchIn,
    response: Response,
    engine: Annotated[Engine, Depends(get_engine)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> BatchOut:
    """Store commands and events atomically. A retried batch returns the original result (200)."""
    with engine.begin() as conn:
        result = ingest_batch(
            conn,
            BatchRequest(
                simulation_id=simulation_id,
                batch_id=body.batch_id,
                through_tick=body.through_tick,
                commands=body.commands,
                events=body.events,
            ),
            settings.kafka_events_topic,
        )
    if result.replayed:
        response.status_code = status.HTTP_200_OK
    return BatchOut(**result.__dict__)


@router.get("/{simulation_id}")
def get_run(simulation_id: UUID, engine: Annotated[Engine, Depends(get_engine)]) -> dict[str, Any]:
    """Run metadata, config, recorded progress and outbox state."""
    with engine.connect() as conn:
        return run_status(conn, simulation_id)


@router.get("/{simulation_id}/commands")
def get_commands(
    simulation_id: UUID, engine: Annotated[Engine, Depends(get_engine)]
) -> dict[str, Any]:
    """The run's command log in application order (input for replay)."""
    with engine.connect() as conn:
        run_status(conn, simulation_id)  # 404 for unknown runs
        return {"simulation_id": str(simulation_id), "commands": list_commands(conn, simulation_id)}


@router.get("/{simulation_id}/events", response_model=EventsPage)
def get_events(
    simulation_id: UUID,
    engine: Annotated[Engine, Depends(get_engine)],
    after_sequence: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_EVENTS_PER_PAGE)] = 1000,
) -> EventsPage:
    """Stored events in sequence order, paginated by sequence."""
    with engine.connect() as conn:
        run_status(conn, simulation_id)
        events = list_events(conn, simulation_id, after_sequence, limit)
    return EventsPage(
        simulation_id=simulation_id,
        events=events,
        next_after_sequence=events[-1]["sequence"] if len(events) == limit else None,
    )
