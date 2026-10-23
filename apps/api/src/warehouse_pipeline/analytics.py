"""Publish analytics snapshots (Phase 4, DEC-036): reconciled gold → `analytics.*` in PostgreSQL.

A snapshot is an immutable, derived copy of the gold models at one build, written in a single
transaction, so the read API always serves a consistent set. It is published only when the latest
reconciliation passed after that gold build (the pipeline vouches for the data); otherwise the
previous snapshot stays current and the API reports the pipeline's state next to it.

What is copied (simulated time as milliseconds since each run's simulated clock origin):
- one row per run from `gold_simulation_activity` (with that origin, `run_epoch`);
- additive per-minute metrics (simulated minutes): events by type (`gold_activity_1m`), pallet
  flows (`gold_pallet_flows`), inventory unit changes (`gold_inventory_movements`);
- one row per task, order and transfer (`gold_task_lifecycle`, `gold_order_fulfilment`,
  `gold_transfers`), so the API can count and take percentiles inside any time window;
- the lake-wide data-quality checks (`gold_data_quality`).

Gold objects are read with DuckDB from the lake (or from a local directory in tests). dbt-duckdb
writes one all-NULL placeholder row for an empty model; those rows are skipped.
"""

import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb
from sqlalchemy import Connection, Engine, delete, insert, select

from warehouse_api.store.tables import (
    analytics_metric_buckets,
    analytics_order_facts,
    analytics_quality_checks,
    analytics_runs,
    analytics_snapshots,
    analytics_task_facts,
    analytics_transfer_facts,
    reconciliation_reports,
    simulation_runs,
)
from warehouse_pipeline.lake import filesystem
from warehouse_pipeline.reconcile import duck
from warehouse_pipeline.settings import PipelineSettings

log = logging.getLogger("warehouse_pipeline.analytics")

#: Version of the metric definitions in docs/phases/PHASE_4.md (bump when a definition changes).
CATALOGUE_VERSION = 1
BUCKET_MS = 60 * 1000
#: Snapshots kept; older ones are deleted with their rows (derived data, republished every refresh).
KEEP_SNAPSHOTS = 20

GOLD_MODELS = (
    "simulation_activity",
    "activity_1m",
    "pallet_flows",
    "inventory_movements",
    "task_lifecycle",
    "order_fulfilment",
    "transfers",
    "data_quality",
)


class PublishRefusedError(Exception):
    """The gold build may not be published (not built, or not cleared by a reconciliation)."""


@dataclass
class GoldSource:
    """Where the gold Parquet objects are: `path(name)` for DuckDB, plus the build time."""

    con: duckdb.DuckDBPyConnection
    paths: dict[str, str]
    built_at: datetime
    silver_events_path: str

    def path(self, name: str) -> str:
        return self.paths[name]


def lake_gold(settings: PipelineSettings) -> GoldSource:
    """Gold in the S3 lake; refuses when a model object is missing."""
    s3 = filesystem(settings)
    keys = {name: f"{settings.lake_bucket}/gold/{name}.parquet" for name in GOLD_MODELS}
    infos = {i.path: i for i in s3.get_file_info(list(keys.values()))}
    missing = [n for n, k in keys.items() if infos[k].mtime is None]
    if missing:
        raise PublishRefusedError(f"gold models not built: {', '.join(missing)}")
    built = min(infos[k].mtime for k in keys.values() if infos[k].mtime is not None)
    return GoldSource(
        con=duck(settings),
        paths={n: f"s3://{k}" for n, k in keys.items()},
        built_at=built if built.tzinfo else built.replace(tzinfo=UTC),
        silver_events_path=f"s3://{settings.lake_bucket}/silver/events.parquet",
    )


def local_gold(directory: Path, built_at: datetime) -> GoldSource:
    """Gold Parquet files in a local directory (`<model>.parquet`, `silver_events.parquet`)."""
    return GoldSource(
        con=duckdb.connect(),
        paths={n: str(directory / f"{n}.parquet") for n in GOLD_MODELS},
        built_at=built_at,
        silver_events_path=str(directory / "silver_events.parquet"),
    )


@dataclass
class SnapshotData:
    runs: list[dict[str, Any]] = field(default_factory=list)
    buckets: list[dict[str, Any]] = field(default_factory=list)
    tasks: list[dict[str, Any]] = field(default_factory=list)
    orders: list[dict[str, Any]] = field(default_factory=list)
    transfers: list[dict[str, Any]] = field(default_factory=list)
    quality: list[dict[str, Any]] = field(default_factory=list)
    source_watermark: datetime | None = None


def _rows(con: duckdb.DuckDBPyConnection, sql: str, params: list[Any]) -> list[dict[str, Any]]:
    cur = con.execute(sql, params)
    names = [d[0] for d in cur.description or []]
    return [dict(zip(names, row, strict=True)) for row in cur.fetchall()]


def read_gold(gold: GoldSource) -> SnapshotData:
    """Everything a snapshot holds, read from the gold models (placeholder rows skipped)."""
    con, p = gold.con, gold.path
    data = SnapshotData()
    data.runs = _rows(
        con,
        """
        select cast(simulation_id as varchar) as simulation_id, events, event_types,
               first_sequence, last_sequence, missing_sequences, redelivered_copies,
               run_epoch_ms,
               last_simulation_time_ms - simulated_span_ms as first_simulation_time_ms,
               last_simulation_time_ms
        from read_parquet(?) where simulation_id is not null order by simulation_id
        """,
        [p("simulation_activity")],
    )
    epochs = (
        "(select simulation_id, run_epoch_ms from read_parquet(?) where simulation_id is not null)"
    )
    bucket = f"(epoch_ms(f.occurred_at) - r.run_epoch_ms) // {BUCKET_MS} * {BUCKET_MS}"
    data.buckets = _rows(
        con,
        f"""
        select cast(simulation_id as varchar) as simulation_id, 'events' as metric,
               event_type as dimension, bucket_ms, events as value
        from read_parquet(?) where simulation_id is not null
        union all
        select cast(f.simulation_id as varchar), 'pallets_' || f.flow,
               case f.flow when 'moved' then f.from_kind || '>' || f.to_kind
                           else coalesce(f.cause_or_reason, 'unknown') end,
               {bucket}, count(*)
        from read_parquet(?) as f join {epochs} as r using (simulation_id)
        where f.simulation_id is not null
        group by all
        union all
        select cast(f.simulation_id as varchar), 'inventory_units', f.movement_type, {bucket},
               sum(f.quantity_change)
        from read_parquet(?) as f join {epochs} as r using (simulation_id)
        where f.simulation_id is not null
        group by all
        order by 1, 2, 3, 4
        """,  # noqa: S608 - only integer constants and a fixed subquery are interpolated
        [
            p("activity_1m"),
            p("pallet_flows"),
            p("simulation_activity"),
            p("inventory_movements"),
            p("simulation_activity"),
        ],
    )
    data.tasks = _rows(
        con,
        """
        select cast(simulation_id as varchar) as simulation_id, task_id, task_type, status,
               created_ms, assigned_ms, completed_ms, cancelled_ms
        from read_parquet(?) where task_id is not null order by 1, 2
        """,
        [p("task_lifecycle")],
    )
    data.orders = _rows(
        con,
        """
        select cast(simulation_id as varchar) as simulation_id, order_id, status, ordered_pallets,
               opened_ms, started_ms, shipped_ms, cancelled_ms
        from read_parquet(?) where order_id is not null order by 1, 2
        """,
        [p("order_fulfilment")],
    )
    data.transfers = _rows(
        con,
        """
        select cast(simulation_id as varchar) as simulation_id, transfer_id, lane_id,
               from_site_id, to_site_id, pallets, status, planned_ms, dispatched_ms,
               delivered_ms, cancelled_ms
        from read_parquet(?) where transfer_id is not null order by 1, 2
        """,
        [p("transfers")],
    )
    data.quality = _rows(
        con,
        "select check_name, kind, value from read_parquet(?) where check_name is not null"
        " order by check_name",
        [p("data_quality")],
    )
    # epoch_ms: DuckDB returns TIMESTAMPTZ values through pytz, which is not a dependency.
    row = con.execute(
        "select epoch_ms(max(first_ingested_at)) from read_parquet(?)", [gold.silver_events_path]
    ).fetchone()
    watermark = (
        datetime.fromtimestamp(int(row[0]) / 1000, UTC) if row and row[0] is not None else None
    )
    data.source_watermark = watermark
    return data


def clearing_report(
    conn: Connection, gold_built_at: datetime, cleared_by: str | None = None
) -> dict[str, Any]:
    """The reconciliation that clears this gold build. With `cleared_by` (a DAG run's
    `triggered_by`), the latest report of that run; otherwise the latest report overall. It must
    have passed, with the models checked, after the build. Raises PublishRefusedError otherwise."""
    query = select(reconciliation_reports).order_by(reconciliation_reports.c.finished_at.desc())
    if cleared_by is not None:
        query = query.where(reconciliation_reports.c.triggered_by == cleared_by)
    latest = conn.execute(query.limit(1)).mappings().first()
    if latest is None:
        which = f"by {cleared_by}" if cleared_by else ""
        raise PublishRefusedError(f"no reconciliation report {which}: run the reconciliation first")
    if latest["status"] != "passed":
        raise PublishRefusedError(
            f"latest reconciliation {latest['report_id']} is {latest['status']}: not publishing"
        )
    if not (latest["metrics"] or {}).get("models_built"):
        raise PublishRefusedError("latest reconciliation did not check the silver/gold models")
    if latest["finished_at"] < gold_built_at:
        raise PublishRefusedError("latest reconciliation is older than the gold build")
    return dict(latest)


@contextmanager
def _closing(gold: GoldSource) -> Iterator[GoldSource]:
    try:
        yield gold
    finally:
        gold.con.close()


@dataclass
class PublishResult:
    snapshot_id: uuid.UUID
    runs: int
    source_events: int
    reconciliation_report_id: uuid.UUID | None
    pruned: int


def publish(
    engine: Engine,
    gold: GoldSource,
    *,
    triggered_by: str,
    cleared_by: str | None = None,
    require_reconciliation: bool = True,
) -> PublishResult:
    """Publish one snapshot atomically and prune old ones. Raises PublishRefusedError."""
    with _closing(gold):
        data = read_gold(gold)
    snapshot_id = uuid.uuid4()
    with engine.begin() as conn:
        report = (
            clearing_report(conn, gold.built_at, cleared_by) if require_reconciliation else None
        )
        scenarios = {
            str(r.simulation_id): r.scenario_id
            for r in conn.execute(
                select(simulation_runs.c.simulation_id, simulation_runs.c.scenario_id)
            )
        }
        epoch = {r["simulation_id"]: int(r["run_epoch_ms"]) for r in data.runs}

        def at(sim: str, ms: int) -> datetime:
            return datetime.fromtimestamp((epoch[sim] + ms) / 1000, UTC)

        business = [
            (
                at(r["simulation_id"], r["first_simulation_time_ms"]),
                at(r["simulation_id"], r["last_simulation_time_ms"]),
            )
            for r in data.runs
        ]
        conn.execute(
            insert(analytics_snapshots).values(
                snapshot_id=snapshot_id,
                catalogue_version=CATALOGUE_VERSION,
                triggered_by=triggered_by,
                gold_built_at=gold.built_at,
                reconciliation_report_id=report["report_id"] if report else None,
                reconciliation_status="passed" if report else "not_required",
                reconciliation_finished_at=report["finished_at"] if report else None,
                source_watermark=data.source_watermark,
                source_events=sum(int(r["events"]) for r in data.runs),
                run_count=len(data.runs),
                business_from=min((b[0] for b in business), default=None),
                business_to=max((b[1] for b in business), default=None),
            )
        )
        tag = {"snapshot_id": snapshot_id}
        if data.runs:
            conn.execute(
                insert(analytics_runs),
                [
                    {
                        **tag,
                        "simulation_id": uuid.UUID(r["simulation_id"]),
                        "scenario_id": scenarios.get(r["simulation_id"]),
                        "run_epoch": datetime.fromtimestamp(int(r["run_epoch_ms"]) / 1000, UTC),
                        **{
                            k: int(r[k])
                            for k in (
                                "events",
                                "event_types",
                                "first_sequence",
                                "last_sequence",
                                "missing_sequences",
                                "redelivered_copies",
                                "first_simulation_time_ms",
                                "last_simulation_time_ms",
                            )
                        },
                    }
                    for r in data.runs
                ],
            )
        for table, rows in (
            (analytics_metric_buckets, data.buckets),
            (analytics_task_facts, data.tasks),
            (analytics_order_facts, data.orders),
            (analytics_transfer_facts, data.transfers),
        ):
            if rows:
                conn.execute(
                    insert(table),
                    [{**tag, **r, "simulation_id": uuid.UUID(r["simulation_id"])} for r in rows],
                )
        if data.quality:
            conn.execute(insert(analytics_quality_checks), [{**tag, **q} for q in data.quality])
        pruned = _prune(conn)
    log.info(
        "analytics snapshot published",
        extra={"snapshot_id": str(snapshot_id), "runs": len(data.runs), "pruned": pruned},
    )
    return PublishResult(
        snapshot_id=snapshot_id,
        runs=len(data.runs),
        source_events=sum(int(r["events"]) for r in data.runs),
        reconciliation_report_id=report["report_id"] if report else None,
        pruned=pruned,
    )


def _prune(conn: Connection) -> int:
    keep = (
        select(analytics_snapshots.c.snapshot_id)
        .order_by(analytics_snapshots.c.generated_at.desc(), analytics_snapshots.c.snapshot_id)
        .limit(KEEP_SNAPSHOTS)
    )
    result = conn.execute(
        delete(analytics_snapshots).where(analytics_snapshots.c.snapshot_id.not_in(keep))
    )
    return int(result.rowcount or 0)
