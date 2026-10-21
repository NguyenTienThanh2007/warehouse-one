"""Publish a consistent, reconciled set of dbt gold rows for the analytics API."""

import json
import uuid
from typing import Any

from sqlalchemy import Engine, func, insert, select

from warehouse_api.store.tables import (
    analytics_model_rows,
    analytics_snapshots,
    domain_events,
    reconciliation_reports,
)
from warehouse_pipeline.reconcile import duck
from warehouse_pipeline.settings import PipelineSettings

GOLD_MODELS = {
    "gold_event_volume_daily": "event_volume_daily",
    "gold_inventory_movements": "inventory_movements",
    "gold_pallet_flows": "pallet_flows",
    "gold_task_lifecycle": "task_lifecycle",
    "gold_order_fulfilment": "order_fulfilment",
    "gold_simulation_activity": "simulation_activity",
    "gold_data_quality": "data_quality",
}


def _model_rows(con: Any, bucket: str, model: str, file_name: str) -> list[dict[str, Any]]:
    path = f"s3://{bucket}/gold/{file_name}.parquet"
    result = con.execute("SELECT * FROM read_parquet(?)", [path])
    columns = [str(col[0]) for col in result.description]
    out: list[dict[str, Any]] = []
    for values in result.fetchall():
        # dbt-duckdb may emit an all-NULL placeholder for an empty external model.
        if all(value is None for value in values):
            continue
        row = dict(zip(columns, values, strict=True))
        out.append(json.loads(json.dumps(row, default=str)))
    return out


def publish_analytics_snapshot(engine: Engine, settings: PipelineSettings) -> dict[str, Any]:
    """Read all gold marts, then atomically publish them under one immutable snapshot ID.

    Publication is refused unless the latest reconciliation report passed. Existing snapshots
    remain available if reading the lake or inserting the new snapshot fails.
    """
    with engine.connect() as conn:
        report = (
            conn.execute(
                select(reconciliation_reports)
                .order_by(reconciliation_reports.c.started_at.desc())
                .limit(1)
            )
            .mappings()
            .first()
        )
        if report is None or report["status"] != "passed":
            status = report["status"] if report else "missing"
            raise RuntimeError(
                f"analytics publication requires a passed reconciliation report; latest={status}"
            )
        source_as_of = conn.execute(select(func.max(domain_events.c.recorded_at))).scalar_one()

    con = duck(settings)
    try:
        model_rows = {
            model: _model_rows(con, settings.lake_bucket, model, file_name)
            for model, file_name in GOLD_MODELS.items()
        }
    finally:
        con.close()

    snapshot_id = uuid.uuid4()
    counts = {name: len(rows) for name, rows in model_rows.items()}
    # One transaction makes snapshot metadata and all its rows visible together.
    with engine.begin() as conn:
        conn.execute(
            insert(analytics_snapshots).values(
                snapshot_id=snapshot_id,
                source_as_of=source_as_of,
                reconciliation_report_id=report["report_id"],
                reconciliation_status="passed",
                model_counts=counts,
            )
        )
        for model, rows in model_rows.items():
            for start in range(0, len(rows), 500):
                batch = [
                    {
                        "snapshot_id": snapshot_id,
                        "model_name": model,
                        "row_index": start + i,
                        "row_data": row,
                    }
                    for i, row in enumerate(rows[start : start + 500])
                ]
                if batch:
                    conn.execute(insert(analytics_model_rows), batch)

    return {
        "snapshot_id": str(snapshot_id),
        "model_counts": counts,
        "source_as_of": source_as_of.isoformat() if source_as_of else None,
        "reconciliation_report_id": str(report["report_id"]),
        "status": "published",
    }
