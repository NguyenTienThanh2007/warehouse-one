"""Analytics read API (Phase 4, DEC-036): published snapshots of the reconciled gold models, with
their freshness and the pipeline's health. Read-only (GET only); no simulation state is touched.
"""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Engine

from warehouse_api.analytics import service
from warehouse_api.analytics.schemas import AnalyticsStatus, RunAnalytics, RunList
from warehouse_api.config import Settings, get_settings
from warehouse_api.db import get_engine

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])

SnapshotParam = Annotated[
    UUID | None,
    Query(description="Pin a snapshot (default: the latest). Pruned snapshots return 404."),
]


@router.get("/status", response_model=AnalyticsStatus)
def get_status(
    engine: Annotated[Engine, Depends(get_engine)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> AnalyticsStatus:
    """The latest snapshot, its freshness, and the pipeline's health. `state` is `empty` when
    nothing has been published yet (200, not an error)."""
    with engine.connect() as conn:
        return service.status(
            conn,
            now=service.now_utc(),
            stale_after_s=settings.analytics_stale_after_s,
            heartbeat_max_age_s=settings.analytics_heartbeat_max_age_s,
        )


@router.get("/runs", response_model=RunList, responses={404: {}})
def get_runs(
    engine: Annotated[Engine, Depends(get_engine)], snapshot_id: SnapshotParam = None
) -> RunList:
    """Runs in a snapshot, newest simulated clock origin first."""
    with engine.connect() as conn:
        return service.list_runs(conn, service.get_snapshot(conn, snapshot_id))


@router.get("/runs/{simulation_id}", response_model=RunAnalytics, responses={404: {}, 422: {}})
def get_run(
    simulation_id: UUID,
    engine: Annotated[Engine, Depends(get_engine)],
    snapshot_id: SnapshotParam = None,
    business_from: Annotated[
        datetime | None,
        Query(alias="from", description="Window start, simulated business time (ISO 8601, UTC)"),
    ] = None,
    business_to: Annotated[
        datetime | None,
        Query(alias="to", description="Window end (exclusive), simulated business time"),
    ] = None,
) -> RunAnalytics:
    """One run's metrics inside a window of simulated time (default: the whole run)."""
    with engine.connect() as conn:
        snapshot = service.get_snapshot(conn, snapshot_id)
        return service.run_analytics(conn, snapshot, simulation_id, business_from, business_to)
