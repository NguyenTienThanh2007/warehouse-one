"""Bronze consumer and rebuild: raw events as Parquet on the lake (DEC-028).

The consumer writes every valid delivered record (redeliveries included: bronze is the audit
trail) to deterministic object keys derived from the Kafka offset range, then records each object
in `pipeline.bronze_objects` in the same transaction that lets the offsets be committed. Object
writes happen before that transaction commits; if the process dies in between, the batch is
processed again and the same keys are overwritten with the same records.

`rebuild_from_postgres` re-creates bronze for a simulated date range straight from the durable
event log (for lost objects or a fresh lake). Rebuilt objects carry `source = postgres-rebuild`;
silver deduplicates them against Kafka-delivered copies by `event_id`.
"""

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import Connection, Engine, delete, func, select
from sqlalchemy.dialects.postgresql import insert

from warehouse_api.ingest.canonical import canonical_json, sha256_hex
from warehouse_api.store.tables import bronze_objects, domain_events
from warehouse_pipeline import __version__
from warehouse_pipeline.consumer import ProcessResult, ValidRecord
from warehouse_pipeline.lake import (
    BronzeObject,
    BronzeRow,
    kafka_name,
    list_objects,
    rebuild_name,
    write_objects,
)
from warehouse_pipeline.settings import PipelineSettings

GROUP = "bronze"


def record_objects(conn: Connection, group: str, objects: list[BronzeObject]) -> None:
    if not objects:
        return
    stmt = insert(bronze_objects)
    conn.execute(
        stmt.on_conflict_do_update(
            index_elements=["object_key"],
            set_={
                "record_count": stmt.excluded.record_count,
                "size_bytes": stmt.excluded.size_bytes,
                "sha256": stmt.excluded.sha256,
                "written_at": func.now(),
            },
        ),
        [
            {
                "object_key": o.key,
                "consumer_group": group,
                "source": o.source,
                "kafka_topic": o.kafka_topic,
                "kafka_partition": o.kafka_partition,
                "first_offset": o.first_offset,
                "last_offset": o.last_offset,
                "event_date": o.event_date,
                "event_type": o.event_type,
                "record_count": o.record_count,
                "size_bytes": o.size_bytes,
                "sha256": o.sha256,
                "pipeline_version": __version__,
            }
            for o in objects
        ],
    )


@dataclass
class BronzeProcessor:
    settings: PipelineSettings
    group: str = GROUP
    written: list[BronzeObject] = field(default_factory=list)

    def process(self, conn: Connection, records: list[ValidRecord]) -> ProcessResult:
        rows = [
            BronzeRow(
                envelope=vr.envelope,
                envelope_json=vr.envelope_json,
                envelope_sha256=vr.envelope_sha256,
                source="kafka",
                kafka_topic=vr.record.topic,
                kafka_partition=vr.record.partition,
                kafka_offset=vr.record.offset,
            )
            for vr in records
        ]
        objects = write_objects(self.settings, rows, kafka_name) if rows else []
        record_objects(conn, self.group, objects)
        self.written = objects
        return ProcessResult(counters={"rows": len(rows), "objects": len(objects)})


@dataclass(frozen=True)
class RebuildResult:
    objects: list[BronzeObject]
    # Manifest entries in the range whose objects no longer exist in the store (lost objects);
    # removed so the manifest describes what is actually there. Their events are re-covered by
    # the rebuilt objects.
    pruned_manifest_keys: list[str]


def rebuild_from_postgres(
    engine: Engine, settings: PipelineSettings, start: date, end: date
) -> RebuildResult:
    """Write bronze for events whose simulated date is in [start, end], from the event log."""
    with engine.connect() as conn:
        envelopes = conn.execute(
            select(domain_events.c.envelope)
            .where(func.date(func.timezone("UTC", domain_events.c.occurred_at)).between(start, end))
            .order_by(domain_events.c.simulation_id, domain_events.c.sequence)
        ).scalars()
        rows: list[BronzeRow] = []
        for env in envelopes:
            envelope: dict[str, Any] = dict(env)
            canonical = canonical_json(envelope)
            rows.append(
                BronzeRow(
                    envelope=envelope,
                    envelope_json=canonical.decode(),
                    envelope_sha256=sha256_hex(canonical),
                    source="postgres-rebuild",
                )
            )
    objects = write_objects(settings, rows, rebuild_name, ingested_at=datetime.now(UTC))
    present = set(list_objects(settings))
    with engine.begin() as conn:
        record_objects(conn, "rebuild", objects)
        in_range = conn.execute(
            select(bronze_objects.c.object_key).where(
                bronze_objects.c.event_date.between(start.isoformat(), end.isoformat())
            )
        ).scalars()
        pruned = sorted(k for k in in_range if k not in present)
        if pruned:
            conn.execute(delete(bronze_objects).where(bronze_objects.c.object_key.in_(pruned)))
    return RebuildResult(objects=objects, pruned_manifest_keys=pruned)
