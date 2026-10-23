"""Queries behind the analytics read API (Phase 4). Read-only: SELECTs on the published snapshot
tables (`analytics.*`) plus pipeline state for freshness and health; nothing here writes.

Window semantics (docs/phases/PHASE_4.md §3): a window is a half-open range [from, to) of
simulated business time on the run's simulated clock. It is snapped outwards to whole buckets of
the series resolution, the smallest of 1, 5, 15, 60, 180, 360 or 1,440 simulated minutes that
keeps the series at or under 240 points. Event-level counts sum the published per-minute buckets
inside it; tasks, orders and transfers are counted by the time
of the transition being measured (created, completed, shipped, delivered…), and durations are
taken over the items that finished inside the window.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Connection, RowMapping, and_, func, select

from warehouse_api.analytics.schemas import (
    AnalyticsStatus,
    ComponentHealth,
    CountByKey,
    Freshness,
    Kpis,
    LaneBreakdown,
    PalletFlow,
    PipelineHealth,
    QualityCheck,
    ReconciliationState,
    RunAnalytics,
    RunIntegrity,
    RunList,
    RunSummary,
    SeriesPoint,
    SnapshotMeta,
    TaskTypeBreakdown,
    Window,
)
from warehouse_api.api.errors import ApiError
from warehouse_api.store.tables import (
    analytics_metric_buckets as mb,
)
from warehouse_api.store.tables import (
    analytics_order_facts as of,
)
from warehouse_api.store.tables import (
    analytics_quality_checks as qc,
)
from warehouse_api.store.tables import (
    analytics_runs as ar,
)
from warehouse_api.store.tables import (
    analytics_snapshots as snap,
)
from warehouse_api.store.tables import (
    analytics_task_facts as tf,
)
from warehouse_api.store.tables import (
    analytics_transfer_facts as xf,
)
from warehouse_api.store.tables import (
    dead_letters,
    domain_events,
    heartbeats,
    outbox,
    reconciliation_reports,
)

#: Width of the published buckets (gold_activity_1m and the publisher): one simulated minute.
STORAGE_BUCKET_MS = 60 * 1000
#: Series resolutions offered (simulated minutes), and the most points one series may have.
RESOLUTIONS_MS = tuple(m * 60_000 for m in (1, 5, 15, 60, 180, 360, 1440))
MAX_POINTS = 240
#: Largest window one request may ask for (simulated time).
MAX_WINDOW = timedelta(days=31)
HOUR_MS = 3_600_000


# --- Snapshots ----------------------------------------------------------------------------------


def latest_snapshot(conn: Connection) -> RowMapping | None:
    return (
        conn.execute(select(snap).order_by(snap.c.generated_at.desc(), snap.c.snapshot_id).limit(1))
        .mappings()
        .first()
    )


def get_snapshot(conn: Connection, snapshot_id: UUID | None) -> RowMapping:
    """The requested snapshot, or the latest. 404 when there is none (or it was pruned)."""
    if snapshot_id is None:
        row = latest_snapshot(conn)
        if row is None:
            raise ApiError(404, "NO_SNAPSHOT", "no analytics snapshot has been published yet")
        return row
    row = conn.execute(select(snap).where(snap.c.snapshot_id == snapshot_id)).mappings().first()
    if row is None:
        raise ApiError(
            404, "SNAPSHOT_NOT_FOUND", f"snapshot {snapshot_id} does not exist (or was pruned)"
        )
    return row


def snapshot_meta(row: RowMapping) -> SnapshotMeta:
    return SnapshotMeta.model_validate(
        {k: row[k] for k in SnapshotMeta.model_fields if k != "time_basis"}
    )


# --- Freshness and pipeline health --------------------------------------------------------------


def pipeline_health(conn: Connection, now: datetime, heartbeat_max_age_s: int) -> PipelineHealth:
    problems: list[str] = []
    rec = (
        conn.execute(
            select(reconciliation_reports)
            .order_by(reconciliation_reports.c.finished_at.desc())
            .limit(1)
        )
        .mappings()
        .first()
    )
    reconciliation = None
    if rec is None:
        problems.append("no reconciliation has run yet")
    else:
        reconciliation = ReconciliationState(
            report_id=rec["report_id"],
            status=rec["status"],
            finished_at=rec["finished_at"],
            triggered_by=rec["triggered_by"],
        )
        if rec["status"] == "failed":
            problems.append(f"latest reconciliation failed (report {rec['report_id']})")
    components = []
    for hb in conn.execute(
        select(heartbeats).order_by(heartbeats.c.component, heartbeats.c.instance)
    ).mappings():
        age = (now - hb["last_beat_at"]).total_seconds()
        healthy = hb["status"] == "ok" and age <= heartbeat_max_age_s
        components.append(
            ComponentHealth(
                component=hb["component"],
                instance=hb["instance"],
                status=hb["status"],
                last_beat_at=hb["last_beat_at"],
                age_seconds=round(age, 1),
                healthy=healthy,
            )
        )
    by_component: dict[str, bool] = {}
    for c in components:
        by_component[c.component] = by_component.get(c.component, False) or c.healthy
    if not components:
        problems.append("no pipeline heartbeats: the relay and consumers have not reported")
    for name, ok in sorted(by_component.items()):
        if not ok:
            problems.append(f"{name} has no healthy instance")
    unpublished = int(
        conn.execute(select(func.count()).where(outbox.c.published_at.is_(None))).scalar_one()
    )
    dead = int(conn.execute(select(func.count()).select_from(dead_letters)).scalar_one())
    if dead:
        problems.append(f"{dead} dead letters need attention")
    return PipelineHealth(
        healthy=not problems,
        problems=problems,
        reconciliation=reconciliation,
        components=components,
        outbox_unpublished=unpublished,
        dead_letters=dead,
    )


def status(
    conn: Connection, *, now: datetime, stale_after_s: int, heartbeat_max_age_s: int
) -> AnalyticsStatus:
    health = pipeline_health(conn, now, heartbeat_max_age_s)
    row = latest_snapshot(conn)
    if row is None:
        return AnalyticsStatus(
            state="empty", server_time=now, snapshot=None, freshness=None, pipeline=health
        )
    age = (now - row["generated_at"]).total_seconds()
    watermark = row["source_watermark"]
    after = select(func.count()).select_from(domain_events)
    if watermark is not None:
        after = after.where(domain_events.c.recorded_at > watermark)
    latest_recorded = conn.execute(select(func.max(domain_events.c.recorded_at))).scalar_one()
    freshness = Freshness(
        age_seconds=round(age, 1),
        stale_after_seconds=stale_after_s,
        is_stale=age > stale_after_s,
        events_recorded_after=int(conn.execute(after).scalar_one()),
        latest_event_recorded_at=latest_recorded,
    )
    state = "degraded" if not health.healthy else "stale" if freshness.is_stale else "fresh"
    return AnalyticsStatus(
        state=state,
        server_time=now,
        snapshot=snapshot_meta(row),
        freshness=freshness,
        pipeline=health,
    )


# --- Runs ---------------------------------------------------------------------------------------


def _at(epoch: datetime, ms: int) -> datetime:
    return epoch + timedelta(milliseconds=ms)


def _summary(r: RowMapping) -> RunSummary:
    return RunSummary(
        simulation_id=r["simulation_id"],
        scenario_id=r["scenario_id"],
        run_epoch=r["run_epoch"],
        business_from=_at(r["run_epoch"], r["first_simulation_time_ms"]),
        business_to=_at(r["run_epoch"], r["last_simulation_time_ms"]),
        simulated_span_ms=r["last_simulation_time_ms"] - r["first_simulation_time_ms"],
        events=r["events"],
        event_types=r["event_types"],
        missing_sequences=r["missing_sequences"],
        redelivered_copies=r["redelivered_copies"],
    )


def list_runs(conn: Connection, snapshot: RowMapping) -> RunList:
    rows = conn.execute(
        select(ar)
        .where(ar.c.snapshot_id == snapshot["snapshot_id"])
        .order_by(ar.c.run_epoch.desc(), ar.c.simulation_id)
    ).mappings()
    return RunList(
        snapshot_id=snapshot["snapshot_id"],
        generated_at=snapshot["generated_at"],
        runs=[_summary(r) for r in rows],
    )


# --- One run inside a window --------------------------------------------------------------------


@dataclass(frozen=True)
class Bounds:
    from_ms: int
    to_ms: int
    bucket_ms: int
    clamped: bool


def resolve_window(
    epoch: datetime,
    first_ms: int,
    last_ms: int,
    requested_from: datetime | None,
    requested_to: datetime | None,
) -> Bounds:
    """Validate a requested business-time window against the run, choose the series resolution
    and snap the window outwards to whole buckets of it."""
    run_from = first_ms // STORAGE_BUCKET_MS * STORAGE_BUCKET_MS
    run_to = (last_ms // STORAGE_BUCKET_MS + 1) * STORAGE_BUCKET_MS  # last event's minute included
    lo = run_from if requested_from is None else _ms(epoch, requested_from)
    hi = run_to if requested_to is None else _ms(epoch, requested_to)
    if lo >= hi:
        raise ApiError(422, "INVALID_WINDOW", "the window's start must be before its end")
    if hi - lo > MAX_WINDOW.total_seconds() * 1000:
        raise ApiError(422, "WINDOW_TOO_LARGE", f"a window may span at most {MAX_WINDOW.days} days")
    if hi <= run_from or lo >= run_to:
        raise ApiError(
            422,
            "WINDOW_OUT_OF_RANGE",
            "the window does not overlap the run",
            {
                "run_business_from": _at(epoch, run_from).isoformat(),
                "run_business_to": _at(epoch, run_to).isoformat(),
            },
        )
    clamped = lo < run_from or hi > run_to
    lo, hi = max(lo, run_from), min(hi, run_to)
    step = next(r for r in RESOLUTIONS_MS if -(-(hi - lo) // r) <= MAX_POINTS)
    return Bounds(lo // step * step, -(-hi // step) * step, step, clamped)


def _ms(epoch: datetime, at: datetime) -> int:
    if at.tzinfo is None:
        raise ApiError(422, "INVALID_WINDOW", "window bounds need a time zone (use Z for UTC)")
    return int((at - epoch) / timedelta(milliseconds=1))


def _in(col: Any, b: Bounds) -> ColumnElement[bool]:
    return and_(col >= b.from_ms, col < b.to_ms)


def _p(fraction: float, expr: Any) -> Any:
    return func.percentile_cont(fraction).within_group(expr)


def _int(v: Any) -> int | None:
    return None if v is None else round(float(v))


def run_analytics(
    conn: Connection,
    snapshot: RowMapping,
    simulation_id: UUID,
    requested_from: datetime | None,
    requested_to: datetime | None,
) -> RunAnalytics:
    sid = snapshot["snapshot_id"]
    run = (
        conn.execute(select(ar).where(ar.c.snapshot_id == sid, ar.c.simulation_id == simulation_id))
        .mappings()
        .first()
    )
    if run is None:
        raise ApiError(404, "RUN_NOT_IN_SNAPSHOT", f"run {simulation_id} is not in snapshot {sid}")
    epoch = run["run_epoch"]
    b = resolve_window(
        epoch,
        run["first_simulation_time_ms"],
        run["last_simulation_time_ms"],
        requested_from,
        requested_to,
    )
    mine = (mb.c.snapshot_id == sid, mb.c.simulation_id == simulation_id)

    # Event-level metrics from the published buckets.
    bucket_rows = conn.execute(
        select(mb.c.metric, mb.c.dimension, mb.c.bucket_ms, mb.c.value).where(
            *mine, _in(mb.c.bucket_ms, b)
        )
    ).all()
    per_bucket: dict[int, dict[str, int]] = {}
    by_metric: dict[tuple[str, str], int] = {}
    for metric, dimension, minute, value in bucket_rows:
        by_metric[(metric, dimension)] = by_metric.get((metric, dimension), 0) + int(value)
        cell = per_bucket.setdefault(minute // b.bucket_ms * b.bucket_ms, {})
        cell[metric] = cell.get(metric, 0) + int(value)

    def total(metric: str, dims: set[str] | None = None) -> int:
        return sum(
            v for (m, d), v in by_metric.items() if m == metric and (dims is None or d in dims)
        )

    # Tasks.
    t_mine = (tf.c.snapshot_id == sid, tf.c.simulation_id == simulation_id)
    cycle = tf.c.completed_ms - tf.c.created_ms
    wait = tf.c.assigned_ms - tf.c.created_ms
    task_totals = conn.execute(
        select(
            func.count().filter(_in(tf.c.created_ms, b)),
            func.count().filter(_in(tf.c.completed_ms, b)),
            func.count().filter(_in(tf.c.cancelled_ms, b)),
            _p(0.5, cycle).filter(_in(tf.c.completed_ms, b)),
            _p(0.9, cycle).filter(_in(tf.c.completed_ms, b)),
            _p(0.5, wait).filter(_in(tf.c.assigned_ms, b)),
        ).where(*t_mine)
    ).one()
    tasks_by_type = [
        TaskTypeBreakdown(
            task_type=r[0] or "unknown",
            created=r[1],
            completed=r[2],
            cancelled=r[3],
            cycle_p50_ms=_int(r[4]),
            cycle_p90_ms=_int(r[5]),
        )
        for r in conn.execute(
            select(
                tf.c.task_type,
                func.count().filter(_in(tf.c.created_ms, b)),
                func.count().filter(_in(tf.c.completed_ms, b)),
                func.count().filter(_in(tf.c.cancelled_ms, b)),
                _p(0.5, cycle).filter(_in(tf.c.completed_ms, b)),
                _p(0.9, cycle).filter(_in(tf.c.completed_ms, b)),
            )
            .where(*t_mine)
            .group_by(tf.c.task_type)
            .order_by(tf.c.task_type)
        )
        if r[1] or r[2] or r[3]
    ]
    created_per_bucket = {
        int(bucket): int(n)
        for bucket, n in conn.execute(
            select((tf.c.created_ms // b.bucket_ms * b.bucket_ms).label("bucket"), func.count())
            .where(*t_mine, _in(tf.c.created_ms, b))
            .group_by("bucket")
        )
    }
    completed_per_bucket = {
        int(bucket): int(n)
        for bucket, n in conn.execute(
            select((tf.c.completed_ms // b.bucket_ms * b.bucket_ms).label("bucket"), func.count())
            .where(*t_mine, _in(tf.c.completed_ms, b))
            .group_by("bucket")
        )
    }

    # Orders.
    o_mine = (of.c.snapshot_id == sid, of.c.simulation_id == simulation_id)
    lead = of.c.shipped_ms - of.c.opened_ms
    order_totals = conn.execute(
        select(
            func.count().filter(_in(of.c.opened_ms, b)),
            func.count().filter(_in(of.c.shipped_ms, b)),
            func.count().filter(_in(of.c.cancelled_ms, b)),
            func.count().filter(
                and_(
                    of.c.opened_ms < b.to_ms,
                    func.coalesce(of.c.shipped_ms, of.c.cancelled_ms, b.to_ms) >= b.to_ms,
                )
            ),
            _p(0.5, lead).filter(_in(of.c.shipped_ms, b)),
            _p(0.9, lead).filter(_in(of.c.shipped_ms, b)),
        ).where(*o_mine)
    ).one()
    order_buckets = {
        int(bucket): int(n)
        for bucket, n in conn.execute(
            select((of.c.shipped_ms // b.bucket_ms * b.bucket_ms).label("bucket"), func.count())
            .where(*o_mine, _in(of.c.shipped_ms, b))
            .group_by("bucket")
        )
    }

    # Transfers (Phase 5 network runs; empty otherwise).
    x_mine = (xf.c.snapshot_id == sid, xf.c.simulation_id == simulation_id)
    x_lead = xf.c.delivered_ms - xf.c.planned_ms
    x_totals = conn.execute(
        select(
            func.count().filter(_in(xf.c.delivered_ms, b)),
            func.coalesce(func.sum(xf.c.pallets).filter(_in(xf.c.delivered_ms, b)), 0),
            _p(0.5, x_lead).filter(_in(xf.c.delivered_ms, b)),
        ).where(*x_mine)
    ).one()
    lanes = [
        LaneBreakdown(
            lane_id=r[0] or "operator request",
            from_site_id=r[1],
            to_site_id=r[2],
            delivered=r[3],
            pallets=int(r[4]),
            lead_p50_ms=_int(r[5]),
        )
        for r in conn.execute(
            select(
                xf.c.lane_id,
                xf.c.from_site_id,
                xf.c.to_site_id,
                func.count(),
                func.coalesce(func.sum(xf.c.pallets), 0),
                _p(0.5, x_lead),
            )
            .where(*x_mine, _in(xf.c.delivered_ms, b))
            .group_by(xf.c.lane_id, xf.c.from_site_id, xf.c.to_site_id)
            .order_by(xf.c.lane_id, xf.c.from_site_id, xf.c.to_site_id)
        )
    ]

    hours = (b.to_ms - b.from_ms) / HOUR_MS
    shipped = total("pallets_removed", {"shipped"})
    series = [
        SeriesPoint(
            bucket_start=_at(epoch, ms),
            offset_ms=ms,
            events=per_bucket.get(ms, {}).get("events", 0),
            tasks_created=created_per_bucket.get(ms, 0),
            tasks_completed=completed_per_bucket.get(ms, 0),
            orders_shipped=order_buckets.get(ms, 0),
            pallets_created=per_bucket.get(ms, {}).get("pallets_created", 0),
            pallets_removed=per_bucket.get(ms, {}).get("pallets_removed", 0),
        )
        for ms in range(b.from_ms, b.to_ms, b.bucket_ms)
    ]
    kpis = Kpis(
        events=total("events"),
        tasks_created=task_totals[0],
        tasks_completed=task_totals[1],
        tasks_cancelled=task_totals[2],
        task_cycle_p50_ms=_int(task_totals[3]),
        task_cycle_p90_ms=_int(task_totals[4]),
        task_wait_p50_ms=_int(task_totals[5]),
        tasks_completed_per_hour=round(task_totals[1] / hours, 2) if hours else None,
        orders_opened=order_totals[0],
        orders_shipped=order_totals[1],
        orders_cancelled=order_totals[2],
        orders_open_at_end=order_totals[3],
        order_lead_p50_ms=_int(order_totals[4]),
        order_lead_p90_ms=_int(order_totals[5]),
        pallets_created=total("pallets_created"),
        pallets_received=total("pallets_created", {"receive", "inbound_truck"}),
        pallets_moved=total("pallets_moved"),
        pallets_shipped=shipped,
        pallets_shipped_per_hour=round(shipped / hours, 2) if hours else None,
        transfers_delivered=x_totals[0],
        transfer_pallets_delivered=int(x_totals[1]),
        transfer_lead_p50_ms=_int(x_totals[2]),
    )
    flows = [
        PalletFlow(flow=m.removeprefix("pallets_"), detail=d, pallets=v)
        for (m, d), v in sorted(by_metric.items())
        if m.startswith("pallets_") and v
    ]
    return RunAnalytics(
        snapshot_id=sid,
        generated_at=snapshot["generated_at"],
        simulation_id=simulation_id,
        scenario_id=run["scenario_id"],
        run_business_from=_at(epoch, run["first_simulation_time_ms"]),
        run_business_to=_at(epoch, run["last_simulation_time_ms"]),
        window=Window(
            business_from=_at(epoch, b.from_ms),
            business_to=_at(epoch, b.to_ms),
            from_ms=b.from_ms,
            to_ms=b.to_ms,
            resolution_ms=b.bucket_ms,
            buckets=len(series),
            clamped=b.clamped,
        ),
        kpis=kpis,
        series=series,
        events_by_type=[
            CountByKey(key=d, value=v)
            for (m, d), v in sorted(by_metric.items(), key=lambda kv: (-kv[1], kv[0]))
            if m == "events" and v
        ],
        tasks_by_type=tasks_by_type,
        pallet_flows=flows,
        inventory_units=[
            CountByKey(key=d, value=v)
            for (m, d), v in sorted(by_metric.items())
            if m == "inventory_units"
        ],
        transfers_by_lane=lanes,
        integrity=RunIntegrity(
            events=run["events"],
            missing_sequences=run["missing_sequences"],
            redelivered_copies=run["redelivered_copies"],
        ),
        quality=[
            QualityCheck(check_name=r.check_name, kind=r.kind, value=r.value)
            for r in conn.execute(
                select(qc).where(qc.c.snapshot_id == sid).order_by(qc.c.check_name)
            )
        ],
    )


def now_utc() -> datetime:
    return datetime.now(UTC)
