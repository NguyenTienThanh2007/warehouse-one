"""Ledger consumer: the deduplicated, version-checked record of every event processed (DEC-027).

Rules, per record, in partition order (one run lives in one partition):

| Situation | Outcome |
|-----------|---------|
| New `event_id`, `aggregate_version` = last + 1 | processed |
| Same `event_id`, identical envelope (redelivery) | skipped as duplicate; `delivery_count` + 1 |
| Same `event_id`, different envelope | dead letter `conflicting_duplicate` |
| New `event_id`, `aggregate_version` ≤ last | dead letter `aggregate_version_regression` |
| New `event_id`, `aggregate_version` > last + 1 | processed; issue `aggregate_version_gap` |
| `sequence` > last processed + 1 for the run | processed; issue `sequence_gap` |

Because duplicates are detected by primary key in the same transaction as the insert, processing
the same batch again (after a crash before the offset commit) cannot double-count.
"""

from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, func, select, update
from sqlalchemy.dialects.postgresql import insert

from warehouse_api.store.tables import aggregate_versions, consumer_events, data_quality_issues
from warehouse_pipeline.consumer import DeadLetter, ProcessResult, ValidRecord

GROUP = "ledger"


@dataclass
class LedgerProcessor:
    group: str = GROUP

    def process(self, conn: Connection, records: list[ValidRecord]) -> ProcessResult:
        result = ProcessResult(counters={"processed": 0, "duplicates": 0, "issues": 0})
        last_seq: dict[str, int] = {}
        for vr in records:
            outcome = self._one(conn, vr, last_seq)
            if isinstance(outcome, DeadLetter):
                result.dead_letters.append(outcome)
            else:
                result.counters[outcome] = result.counters.get(outcome, 0) + 1
        return result

    def _one(self, conn: Connection, vr: ValidRecord, last_seq: dict[str, int]) -> Any:
        e, r = vr.event, vr.record
        event_id, sim = e.event_id, str(e.simulation_id)
        seen = conn.execute(
            select(consumer_events.c.envelope_sha256).where(
                consumer_events.c.consumer_group == self.group,
                consumer_events.c.event_id == event_id,
            )
        ).scalar_one_or_none()
        if seen is not None:
            if seen != vr.envelope_sha256:
                return DeadLetter(
                    r,
                    "conflicting_duplicate",
                    "event_id already processed with a different envelope",
                    str(event_id),
                    sim,
                )
            conn.execute(
                update(consumer_events)
                .where(
                    consumer_events.c.consumer_group == self.group,
                    consumer_events.c.event_id == event_id,
                )
                .values(
                    delivery_count=consumer_events.c.delivery_count + 1,
                    last_delivered_at=func.now(),
                )
            )
            return "duplicates"

        key = (self.group, e.simulation_id, e.aggregate_type, e.aggregate_id)
        last_version = (
            conn.execute(
                select(aggregate_versions.c.last_version).where(
                    aggregate_versions.c.consumer_group == key[0],
                    aggregate_versions.c.simulation_id == key[1],
                    aggregate_versions.c.aggregate_type == key[2],
                    aggregate_versions.c.aggregate_id == key[3],
                )
            ).scalar_one_or_none()
            or 0
        )
        if e.aggregate_version <= last_version:
            return DeadLetter(
                r,
                "aggregate_version_regression",
                f"{e.aggregate_type}/{e.aggregate_id} version {e.aggregate_version} after "
                f"{last_version} with a new event_id",
                str(event_id),
                sim,
            )

        issues: list[tuple[str, dict[str, Any]]] = []
        if e.aggregate_version > last_version + 1:
            issues.append(
                (
                    "aggregate_version_gap",
                    {
                        "aggregate": f"{e.aggregate_type}/{e.aggregate_id}",
                        "expected": last_version + 1,
                        "got": e.aggregate_version,
                    },
                )
            )
        if sim not in last_seq:
            last_seq[sim] = int(
                conn.execute(
                    select(func.coalesce(func.max(consumer_events.c.sequence), 0)).where(
                        consumer_events.c.consumer_group == self.group,
                        consumer_events.c.simulation_id == e.simulation_id,
                    )
                ).scalar_one()
            )
        if e.sequence > last_seq[sim] + 1:
            issues.append(("sequence_gap", {"expected": last_seq[sim] + 1, "got": e.sequence}))
        last_seq[sim] = max(last_seq[sim], e.sequence)

        conn.execute(
            insert(consumer_events).values(
                consumer_group=self.group,
                event_id=event_id,
                simulation_id=e.simulation_id,
                sequence=e.sequence,
                event_type=e.event_type,
                aggregate_type=e.aggregate_type,
                aggregate_id=e.aggregate_id,
                aggregate_version=e.aggregate_version,
                envelope_sha256=vr.envelope_sha256,
                kafka_topic=r.topic,
                kafka_partition=r.partition,
                kafka_offset=r.offset,
            )
        )
        upsert = insert(aggregate_versions).values(
            consumer_group=key[0],
            simulation_id=key[1],
            aggregate_type=key[2],
            aggregate_id=key[3],
            last_version=e.aggregate_version,
            last_event_id=event_id,
        )
        conn.execute(
            upsert.on_conflict_do_update(
                index_elements=[
                    "consumer_group",
                    "simulation_id",
                    "aggregate_type",
                    "aggregate_id",
                ],
                set_={
                    "last_version": upsert.excluded.last_version,
                    "last_event_id": upsert.excluded.last_event_id,
                    "updated_at": func.now(),
                },
            )
        )
        for issue_type, details in issues:
            conn.execute(
                insert(data_quality_issues)
                .values(
                    consumer_group=self.group,
                    issue_type=issue_type,
                    simulation_id=e.simulation_id,
                    event_id=event_id,
                    details=details,
                    kafka_topic=r.topic,
                    kafka_partition=r.partition,
                    kafka_offset=r.offset,
                )
                .on_conflict_do_nothing(
                    index_elements=[
                        "consumer_group",
                        "issue_type",
                        "kafka_topic",
                        "kafka_partition",
                        "kafka_offset",
                    ]
                )
            )
        return "processed" if not issues else "issues"
