"""Read-only analytics endpoints backed by the latest published, reconciled snapshot."""

from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Engine, func, select

from warehouse_api.api.errors import ApiError
from warehouse_api.db import get_engine
from warehouse_api.store.tables import (
    analytics_model_rows,
    analytics_snapshots,
    heartbeats,
    reconciliation_reports,
)

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])
STALE_SNAPSHOT_AFTER = timedelta(minutes=90)
NO_RECENT_INPUT_AFTER = timedelta(hours=24)
HEARTBEAT_MAX_AGE = timedelta(seconds=60)


def _snapshot(conn: Any) -> dict[str, Any]:
    row = (
        conn.execute(
            select(analytics_snapshots)
            .order_by(analytics_snapshots.c.published_at.desc())
            .limit(1)
        )
        .mappings()
        .first()
    )
    if row is None:
        raise ApiError(
            503,
            "ANALYTICS_NOT_PUBLISHED",
            "No reconciled analytics snapshot has been published yet.",
        )
    return dict(row)


def _freshness(snapshot: dict[str, Any], now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    published_at = snapshot["published_at"]
    if published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=UTC)
    if now - published_at > STALE_SNAPSHOT_AFTER:
        return "stale"
    source_as_of = snapshot["source_as_of"]
    if source_as_of is None:
        return "no_recent_input"
    if source_as_of.tzinfo is None:
        source_as_of = source_as_of.replace(tzinfo=UTC)
    if now - source_as_of > NO_RECENT_INPUT_AFTER:
        return "no_recent_input"
    return "fresh"


def _snapshot_meta(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "snapshot_id": str(snapshot["snapshot_id"]),
        "as_of": snapshot["published_at"],
        "source_as_of": snapshot["source_as_of"],
        "reconciliation_status": snapshot["reconciliation_status"],
        "freshness": _freshness(snapshot),
        "model_counts": snapshot["model_counts"],
    }


def _rows(
    conn: Any,
    snapshot_id: UUID,
    model_name: str,
    simulation_id: UUID | None = None,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    conditions = [
        analytics_model_rows.c.snapshot_id == snapshot_id,
        analytics_model_rows.c.model_name == model_name,
    ]
    if simulation_id is not None:
        conditions.append(
            analytics_model_rows.c.row_data["simulation_id"].astext == str(simulation_id)
        )
    total = int(
        conn.execute(
            select(func.count()).select_from(analytics_model_rows).where(*conditions)
        ).scalar_one()
    )
    rows = conn.execute(
        select(analytics_model_rows.c.row_data)
        .where(*conditions)
        .order_by(analytics_model_rows.c.row_index)
        .offset(offset)
        .limit(limit)
    ).scalars().all()
    return [dict(row) for row in rows], total


def _list_response(
    engine: Engine,
    model_name: str,
    simulation_id: UUID | None,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    with engine.connect() as conn:
        snapshot = _snapshot(conn)
        rows, total = _rows(conn, snapshot["snapshot_id"], model_name, simulation_id, limit, offset)
    return {
        **_snapshot_meta(snapshot),
        "filters": {"simulation_id": str(simulation_id) if simulation_id else None},
        "rows": rows,
        "page": {"limit": limit, "offset": offset, "total": total},
    }


@router.get("/overview")
def overview(
    engine: Engine = Depends(get_engine),
    simulation_id: UUID | None = Query(default=None),
) -> dict[str, Any]:
    """Summary KPIs calculated from published gold marts, not from live UI state."""
    with engine.connect() as conn:
        snapshot = _snapshot(conn)
        activity, _ = _rows(
            conn, snapshot["snapshot_id"], "gold_simulation_activity", simulation_id, 10_000
        )
        orders, _ = _rows(
            conn, snapshot["snapshot_id"], "gold_order_fulfilment", simulation_id, 10_000
        )
        tasks, _ = _rows(
            conn, snapshot["snapshot_id"], "gold_task_lifecycle", simulation_id, 10_000
        )
        inventory, _ = _rows(
            conn, snapshot["snapshot_id"], "gold_inventory_movements", simulation_id, 10_000
        )
        pallet_flows, _ = _rows(
            conn, snapshot["snapshot_id"], "gold_pallet_flows", simulation_id, 10_000
        )
        quality, _ = _rows(conn, snapshot["snapshot_id"], "gold_data_quality", None, 10_000)

    shipped = [r for r in orders if r.get("status") == "shipped"]
    cancelled = [r for r in orders if r.get("status") == "cancelled"]
    lead_times = [float(r["lead_time_ms"]) for r in shipped if r.get("lead_time_ms") is not None]
    completed = [r for r in tasks if r.get("status") == "completed"]
    wait_times = [float(r["wait_ms"]) for r in tasks if r.get("wait_ms") is not None]
    service_times = [float(r["service_ms"]) for r in completed if r.get("service_ms") is not None]
    quality_errors = sum(
        int(r["value"])
        for r in quality
        if r.get("kind") == "error" and r.get("value") is not None
    )

    return {
        **_snapshot_meta(snapshot),
        "filters": {"simulation_id": str(simulation_id) if simulation_id else None},
        "metrics": {
            "recorded_simulations": len(activity),
            "domain_events": sum(int(r.get("events") or 0) for r in activity),
            "orders_shipped": len(shipped),
            "orders_cancelled": len(cancelled),
            "mean_order_lead_time_ms": sum(lead_times) / len(lead_times) if lead_times else None,
            "tasks_completed": len(completed),
            "mean_task_wait_ms": sum(wait_times) / len(wait_times) if wait_times else None,
            "mean_task_service_ms": (
                sum(service_times) / len(service_times) if service_times else None
            ),
            "inventory_movement_rows": len(inventory),
            "pallet_flow_events": len(pallet_flows),
            "data_quality_errors_global": quality_errors,
        },
        "sample_counts": {
            "order_lead_time": len(lead_times),
            "task_wait_time": len(wait_times),
            "task_service_time": len(service_times),
        },
    }



@router.get("/throughput")
def throughput(
    engine: Engine = Depends(get_engine),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    limit: int = Query(default=30, ge=1, le=90),
) -> dict[str, Any]:
    """Daily domain-event volume by simulated business date; not physical order throughput."""
    if start_date and end_date and end_date < start_date:
        raise ApiError(422, "INVALID_DATE_RANGE", "end_date must be on or after start_date")
    with engine.connect() as conn:
        snapshot = _snapshot(conn)
        rows, _ = _rows(
            conn, snapshot["snapshot_id"], "gold_event_volume_daily", limit=10_000
        )

    filtered = [
        row
        for row in rows
        if row.get("event_date") is not None
        and (start_date is None or str(row["event_date"]) >= start_date.isoformat())
        and (end_date is None or str(row["event_date"]) <= end_date.isoformat())
    ]
    daily: dict[str, dict[str, int]] = {}
    for row in filtered:
        day = str(row["event_date"])
        item = daily.setdefault(day, {"events": 0, "simulations": 0, "redelivered_copies": 0})
        item["events"] += int(row.get("events") or 0)
        item["simulations"] += int(row.get("simulations") or 0)
        item["redelivered_copies"] += int(row.get("redelivered_copies") or 0)
    series = [{"event_date": day, **values} for day, values in sorted(daily.items())[-limit:]]
    return {
        **_snapshot_meta(snapshot),
        "time_basis": "simulated",
        "definition": "Distinct domain events grouped by simulated business date.",
        "filters": {
            "start_date": start_date.isoformat() if start_date else None,
            "end_date": end_date.isoformat() if end_date else None,
            "limit": limit,
        },
        "daily": series,
    }


@router.get("/orders")
def orders(
    engine: Engine = Depends(get_engine),
    simulation_id: UUID | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    return _list_response(engine, "gold_order_fulfilment", simulation_id, limit, offset)


@router.get("/tasks")
def tasks(
    engine: Engine = Depends(get_engine),
    simulation_id: UUID | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    return _list_response(engine, "gold_task_lifecycle", simulation_id, limit, offset)


@router.get("/inventory")
def inventory(
    engine: Engine = Depends(get_engine),
    simulation_id: UUID | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    return _list_response(engine, "gold_inventory_movements", simulation_id, limit, offset)


@router.get("/health")
def analytics_health(engine: Engine = Depends(get_engine)) -> dict[str, Any]:
    """Pipeline health is independent from API liveness and analytics snapshot freshness."""
    now = datetime.now(UTC)
    with engine.connect() as conn:
        snapshot_row = (
            conn.execute(
                select(analytics_snapshots)
                .order_by(analytics_snapshots.c.published_at.desc())
                .limit(1)
            )
            .mappings()
            .first()
        )
        beat_rows = conn.execute(select(heartbeats)).mappings().all()
        report = (
            conn.execute(
                select(reconciliation_reports)
                .order_by(reconciliation_reports.c.started_at.desc())
                .limit(1)
            )
            .mappings()
            .first()
        )

    latest: dict[str, Any] = {}
    for row in beat_rows:
        current = latest.get(row["component"])
        if current is None or row["last_beat_at"] > current["last_beat_at"]:
            latest[row["component"]] = dict(row)

    components: dict[str, Any] = {}
    for name in ("relay", "consumer-ledger", "consumer-bronze"):
        beat = latest.get(name)
        age_s = None
        healthy = False
        if beat:
            stamp = beat["last_beat_at"]
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=UTC)
            age_s = max(0.0, (now - stamp).total_seconds())
            healthy = beat["status"] == "ok" and age_s <= HEARTBEAT_MAX_AGE.total_seconds()
        components[name] = {
            "status": "healthy" if healthy else "degraded",
            "last_beat_at": beat["last_beat_at"] if beat else None,
            "age_seconds": round(age_s, 1) if age_s is not None else None,
        }

    reconciliation = (
        None
        if report is None
        else {
            "status": report["status"],
            "started_at": report["started_at"],
            "finished_at": report["finished_at"],
            "violations": report["violations"],
        }
    )
    healthy = (
        all(component["status"] == "healthy" for component in components.values())
        and report is not None
        and report["status"] == "passed"
        and snapshot_row is not None
    )
    return {
        "status": "healthy" if healthy else "degraded",
        "components": components,
        "latest_reconciliation": reconciliation,
        "snapshot": _snapshot_meta(dict(snapshot_row)) if snapshot_row else None,
    }
