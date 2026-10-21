"""Operational tools: per-run status across every layer, and explicit replay.

Replay re-publishes a run's stored events from the outbox to Kafka (already published rows
included). It is the documented way to re-feed consumers: the ledger counts the copies as
redeliveries without double-counting, bronze keeps them (auditable), silver deduplicates by
`event_id`, so analytical outputs do not change.
"""

from typing import Any
from uuid import UUID

import duckdb
from confluent_kafka import KafkaError, Message
from sqlalchemy import Engine, func, select

from warehouse_api.store.tables import (
    bronze_objects,
    consumer_events,
    data_quality_issues,
    dead_letters,
    domain_events,
    outbox,
    reconciliation_reports,
)
from warehouse_pipeline.kafka import producer
from warehouse_pipeline.lake import BRONZE_PREFIX, filesystem
from warehouse_pipeline.ledger import GROUP as LEDGER_GROUP
from warehouse_pipeline.reconcile import duck
from warehouse_pipeline.settings import PipelineSettings


def run_status(engine: Engine, settings: PipelineSettings, simulation_id: UUID) -> dict[str, Any]:
    sim = str(simulation_id)
    with engine.connect() as conn:
        events = conn.execute(
            select(func.count()).where(domain_events.c.simulation_id == simulation_id)
        ).scalar_one()
        unpublished = conn.execute(
            select(func.count()).where(
                outbox.c.simulation_id == simulation_id, outbox.c.published_at.is_(None)
            )
        ).scalar_one()
        ledger, deliveries = conn.execute(
            select(
                func.count(), func.coalesce(func.sum(consumer_events.c.delivery_count), 0)
            ).where(
                consumer_events.c.consumer_group == LEDGER_GROUP,
                consumer_events.c.simulation_id == simulation_id,
            )
        ).one()
        dead = conn.execute(
            select(func.count()).where(dead_letters.c.simulation_id == sim)
        ).scalar_one()
        issues = conn.execute(
            select(func.count()).where(data_quality_issues.c.simulation_id == simulation_id)
        ).scalar_one()
        manifest = conn.execute(select(func.count()).select_from(bronze_objects)).scalar_one()
        latest = (
            conn.execute(
                select(reconciliation_reports)
                .order_by(reconciliation_reports.c.started_at.desc())
                .limit(1)
            )
            .mappings()
            .first()
        )
    lake = _lake_counts(settings, sim, int(manifest))
    return {
        "simulation_id": sim,
        "source_events": int(events),
        "outbox_unpublished": int(unpublished),
        "ledger_events": int(ledger),
        "ledger_deliveries": int(deliveries),
        **lake,
        "dead_letters": int(dead),
        "data_quality_issues": int(issues),
        "bronze_objects_total": int(manifest),
        "latest_reconciliation": None
        if latest is None
        else {
            "status": latest["status"],
            "triggered_by": latest["triggered_by"],
            "started_at": latest["started_at"].isoformat(),
            "violations": latest["violations"],
            "metrics": latest["metrics"],
        },
    }


def replay(
    engine: Engine, settings: PipelineSettings, simulation_id: UUID, limit: int | None
) -> dict[str, Any]:
    """Re-publish a run's stored events (in sequence order) to its topic; acks=all."""
    with engine.connect() as conn:
        query = (
            select(outbox.c.topic, outbox.c.message_key, outbox.c.message_value, outbox.c.headers)
            .where(outbox.c.simulation_id == simulation_id)
            .order_by(outbox.c.sequence)
        )
        rows = conn.execute(query.limit(limit) if limit else query).all()
    p = producer(settings, f"replay-{settings.instance_id}")
    errors: list[str] = []

    def on_delivery(err: KafkaError | None, _msg: Message) -> None:
        if err is not None:
            errors.append(str(err))

    for topic, key, value, headers in rows:
        hdrs: list[tuple[str, str | bytes | None]] = [
            (str(k), str(v).encode()) for k, v in sorted(headers.items())
        ]
        hdrs.append(("replay", b"true"))
        p.produce(
            topic, key=key.encode(), value=bytes(value), headers=hdrs, on_delivery=on_delivery
        )
        p.poll(0)
    remaining = p.flush(settings.kafka_delivery_timeout_ms / 1000 + 5)
    if errors or remaining:
        raise RuntimeError(f"replay incomplete: {remaining} undelivered, errors {errors[:3]}")
    return {"simulation_id": str(simulation_id), "republished": len(rows)}


def _lake_counts(settings: PipelineSettings, sim: str, manifest: int) -> dict[str, Any]:
    """Bronze and gold counts for one run, read from the Parquet objects. When the object store
    is unreachable the counts are None and `lake_error` says why (status still answers)."""
    out: dict[str, Any] = {
        "bronze_rows": 0,
        "bronze_distinct_events": 0,
        "gold_events": None,
        "lake_error": None,
    }
    try:
        con = duck(settings)
        if manifest:
            row = con.execute(
                "SELECT count(*), count(DISTINCT event_id) "
                "FROM read_parquet(?, hive_partitioning = true) WHERE simulation_id = ?",
                [f"s3://{settings.lake_bucket}/{BRONZE_PREFIX}/**/*.parquet", sim],
            ).fetchone()
            if row:
                out["bronze_rows"], out["bronze_distinct_events"] = int(row[0]), int(row[1])
        gold = f"{settings.lake_bucket}/gold/simulation_activity.parquet"
        if filesystem(settings).get_file_info(gold).size:
            row = con.execute(
                "SELECT events FROM read_parquet(?) WHERE simulation_id = ?", [f"s3://{gold}", sim]
            ).fetchone()
            out["gold_events"] = int(row[0]) if row and row[0] is not None else 0
    except (OSError, duckdb.Error) as exc:
        out.update(bronze_rows=None, bronze_distinct_events=None, lake_error=str(exc)[:300])
    return out
