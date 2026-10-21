"""Consumers against real PostgreSQL, Kafka and an S3-compatible store (DEC-027, DEC-028).

Run with: uv run pytest -m kafka (needs WAREHOUSE_DATABASE_URL, WAREHOUSE_KAFKA_BOOTSTRAP_SERVERS
and, for bronze, WAREHOUSE_S3_ENDPOINT / WAREHOUSE_S3_ACCESS_KEY / WAREHOUSE_S3_SECRET_KEY).
"""

import base64
import json
import time
import uuid
from datetime import date
from typing import Any

import pytest
from confluent_kafka import Producer, TopicPartition
from sqlalchemy import Engine, func, select
from sqlalchemy.exc import OperationalError

from tests.integration.conftest import RunFixture
from tests.integration.kafka_support import drain, isolated_settings, store_run
from warehouse_api.store.tables import (
    aggregate_versions,
    bronze_objects,
    consumer_events,
    data_quality_issues,
    dead_letters,
    outbox,
)
from warehouse_pipeline.bronze import BronzeProcessor, rebuild_from_postgres
from warehouse_pipeline.consumer import ConsumerService, ProcessResult
from warehouse_pipeline.kafka import ensure_topics
from warehouse_pipeline.lake import ensure_bucket, list_objects, read_object
from warehouse_pipeline.ledger import LedgerProcessor
from warehouse_pipeline.relay import OutboxRelay
from warehouse_pipeline.settings import PipelineSettings

pytestmark = [pytest.mark.integration, pytest.mark.kafka]


def lake_settings(**overrides: Any) -> PipelineSettings:
    return isolated_settings(lake_bucket=f"test-lake-{uuid.uuid4().hex[:10]}", **overrides)


def publish_run(engine: Engine, settings: PipelineSettings, run: RunFixture) -> None:
    ensure_topics(settings)
    store_run(engine, run, settings.kafka_events_topic)
    relay = OutboxRelay(engine, settings, owner="relay-t")
    while relay.run_once().simulation_id is not None:
        pass


def consume_until(service: ConsumerService, records: int, timeout_s: float = 60) -> None:
    deadline = time.monotonic() + timeout_s
    while service.totals["records"] < records:
        if time.monotonic() > deadline:
            raise AssertionError(f"consumed {service.totals['records']} of {records}")
        service.step()


def produce_raw(settings: PipelineSettings, values: list[tuple[bytes, bytes | None]]) -> None:
    p = Producer({"bootstrap.servers": settings.kafka_bootstrap_servers})
    for key, value in values:
        p.produce(settings.kafka_events_topic, key=key, value=value)
    assert p.flush(10) == 0


def redeliver_first(engine: Engine, settings: PipelineSettings, n: int) -> None:
    """What a relay crash after the broker's ack does: the same messages are produced again."""
    with engine.connect() as conn:
        rows = conn.execute(
            select(outbox.c.message_key, outbox.c.message_value)
            .order_by(outbox.c.sequence)
            .limit(n)
        ).all()
    produce_raw(settings, [(k.encode(), bytes(v)) for k, v in rows])


def count(engine: Engine, table: Any, *where: Any) -> int:
    with engine.connect() as conn:
        return int(conn.execute(select(func.count()).select_from(table).where(*where)).scalar_one())


# Ledger ---------------------------------------------------------------------------------------


def test_ledger_processes_every_event_once_and_counts_redeliveries(
    engine: Engine, ops_demo: RunFixture
) -> None:
    settings = isolated_settings()
    publish_run(engine, settings, ops_demo)
    service = ConsumerService(engine, settings, LedgerProcessor(), instance="t1")
    service.subscribe()
    try:
        consume_until(service, len(ops_demo.events))
        assert count(engine, consumer_events) == len(ops_demo.events)
        assert count(engine, dead_letters) == 0 and count(engine, data_quality_issues) == 0
        expected_versions: dict[tuple[str, str], int] = {}
        for e in ops_demo.events:
            expected_versions[(e["aggregate_type"], e["aggregate_id"])] = e["aggregate_version"]
        with engine.connect() as conn:
            stored = {
                (t, i): v
                for t, i, v in conn.execute(
                    select(
                        aggregate_versions.c.aggregate_type,
                        aggregate_versions.c.aggregate_id,
                        aggregate_versions.c.last_version,
                    )
                )
            }
        assert stored == expected_versions

        redeliver_first(engine, settings, 40)
        consume_until(service, len(ops_demo.events) + 40)
        assert count(engine, consumer_events) == len(ops_demo.events)  # no double counting
        assert count(engine, consumer_events, consumer_events.c.delivery_count == 2) == 40
        assert service.totals["duplicates"] == 40
    finally:
        service.close()


def test_poison_messages_go_to_the_dlq_with_their_coordinates(
    engine: Engine, ops_demo: RunFixture
) -> None:
    settings = isolated_settings()
    ensure_topics(settings)
    first = ops_demo.events[0]
    key = first["simulation_id"].encode()
    later = next(
        e
        for e in ops_demo.events
        if e["aggregate_version"] == 1
        and (e["aggregate_type"], e["aggregate_id"])
        != (first["aggregate_type"], first["aggregate_id"])
    )
    gap = dict(later) | {"aggregate_version": 3}
    conflicting = dict(first) | {"correlation_id": "tampered"}
    regression = dict(first) | {"event_id": str(uuid.uuid4()), "sequence": 999}
    values: list[tuple[bytes, bytes | None]] = [
        (key, b"\x00\xffgarbage"),
        (key, json.dumps(dict(first) | {"payload": {"sku": "x"}}).encode()),
        (key, json.dumps(first).encode()),
        (key, json.dumps(conflicting).encode()),
        (key, json.dumps(regression).encode()),
        (key, json.dumps(gap).encode()),
    ]
    produce_raw(settings, values)
    service = ConsumerService(engine, settings, LedgerProcessor(), instance="t2")
    service.subscribe()
    try:
        consume_until(service, len(values))
        with engine.connect() as conn:
            rows = (
                conn.execute(select(dead_letters).order_by(dead_letters.c.source_offset))
                .mappings()
                .all()
            )
        assert [r["error_class"] for r in rows] == [
            "undecodable",
            "contract_violation",
            "conflicting_duplicate",
            "aggregate_version_regression",
        ]
        assert [r["source_offset"] for r in rows] == [0, 1, 3, 4]
        assert bytes(rows[0]["message_value"]) == b"\x00\xffgarbage"
        assert rows[1]["event_id"] == first["event_id"]
        assert all(r["dlq_offset"] is not None for r in rows)
        dlq = drain(settings, settings.kafka_dlq_topic, 4)
        bodies = [json.loads(m.value) for m in sorted(dlq, key=lambda m: m.offset)]
        assert [b["error_class"] for b in bodies] == [r["error_class"] for r in rows]
        assert base64.b64decode(bodies[0]["original_value_base64"]) == b"\x00\xffgarbage"
        assert bodies[2]["source"] == {
            "topic": settings.kafka_events_topic,
            "partition": rows[2]["source_partition"],
            "offset": 3,
        }
        issues = count(
            engine, data_quality_issues, data_quality_issues.c.issue_type == "aggregate_version_gap"
        )
        assert issues == 1
        assert count(engine, consumer_events) == 2  # the valid first event and the gapped one
        # The consumer moved past every record: offsets committed through the last one.
        committed = service.consumer.committed(
            [TopicPartition(settings.kafka_events_topic, rows[0]["source_partition"])], timeout=5
        )
        assert committed[0].offset == len(values)
    finally:
        service.close()


def test_transient_failures_are_retried_and_never_dead_lettered(
    engine: Engine, ops_demo: RunFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = isolated_settings(consumer_retry_attempts=3)
    publish_run(engine, settings, ops_demo)
    real = LedgerProcessor.process
    calls = {"n": 0}

    def flaky(self: LedgerProcessor, conn: Any, records: Any) -> ProcessResult:
        calls["n"] += 1
        if calls["n"] <= 2:
            raise OperationalError("SELECT 1", {}, Exception("database restarting"))
        return real(self, conn, records)

    monkeypatch.setattr(LedgerProcessor, "process", flaky)
    service = ConsumerService(engine, settings, LedgerProcessor(), instance="t3")
    service.subscribe()
    try:
        consume_until(service, len(ops_demo.events))
    finally:
        service.close()
    assert calls["n"] >= 3
    assert count(engine, consumer_events) == len(ops_demo.events)
    assert count(engine, dead_letters) == 0

    # A failure that outlasts the retry budget rewinds and commits nothing.
    settings2 = isolated_settings(consumer_retry_attempts=2)
    publish_run_events_only(engine, settings2, ops_demo)

    def down(self: LedgerProcessor, conn: Any, records: Any) -> ProcessResult:
        raise OperationalError("SELECT 1", {}, Exception("database down"))

    monkeypatch.setattr(LedgerProcessor, "process", down)
    failing = ConsumerService(engine, settings2, LedgerProcessor(group="ledger-b"), instance="t4")
    failing.subscribe()
    try:
        with pytest.raises(OperationalError):
            while True:
                failing.step()
        tps = failing.consumer.assignment()
        assert all(tp.offset < 0 for tp in failing.consumer.committed(tps, timeout=5))
    finally:
        failing.close()
    monkeypatch.setattr(LedgerProcessor, "process", real)
    recovered = ConsumerService(engine, settings2, LedgerProcessor(group="ledger-b"), instance="t5")
    recovered.subscribe()
    try:
        consume_until(recovered, len(ops_demo.events))
    finally:
        recovered.close()
    assert count(engine, consumer_events, consumer_events.c.consumer_group == "ledger-b") == len(
        ops_demo.events
    )


def publish_run_events_only(engine: Engine, settings: PipelineSettings, run: RunFixture) -> None:
    """Re-produce an already stored run's events to another topic (for a second scenario)."""
    ensure_topics(settings)
    with engine.connect() as conn:
        rows = conn.execute(
            select(outbox.c.message_key, outbox.c.message_value).order_by(outbox.c.sequence)
        ).all()
    produce_raw(settings, [(k.encode(), bytes(v)) for k, v in rows])


def test_crash_before_offset_commit_is_reprocessed_without_double_counting(
    engine: Engine, ops_demo: RunFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = isolated_settings(consumer_batch_size=50)
    publish_run(engine, settings, ops_demo)
    crashing = ConsumerService(engine, settings, LedgerProcessor(), instance="t6")

    def die(_batch: Any) -> None:
        raise RuntimeError("killed before the offset commit")

    monkeypatch.setattr(crashing, "commit", die)
    crashing.subscribe()
    try:
        with pytest.raises(RuntimeError):
            while True:
                crashing.step()
    finally:
        crashing.close()
    processed_before_crash = count(engine, consumer_events)
    assert processed_before_crash > 0

    restarted = ConsumerService(engine, settings, LedgerProcessor(), instance="t7")
    restarted.subscribe()
    try:
        consume_until(restarted, len(ops_demo.events))
    finally:
        restarted.close()
    assert count(engine, consumer_events) == len(ops_demo.events)
    assert (
        count(engine, consumer_events, consumer_events.c.delivery_count == 2)
        == processed_before_crash
    )


# Bronze -------------------------------------------------------------------------------------


def bronze_rows(settings: PipelineSettings) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for key in sorted(list_objects(settings)):
        rows.extend(read_object(settings, key).to_pylist())
    return rows


def test_bronze_writes_partitioned_parquet_with_a_manifest_and_keeps_redeliveries(
    engine: Engine, ops_demo: RunFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = lake_settings()
    ensure_bucket(settings)
    publish_run(engine, settings, ops_demo)

    crashing = ConsumerService(engine, settings, BronzeProcessor(settings), instance="b1")
    monkeypatch.setattr(
        crashing, "commit", lambda _b: (_ for _ in ()).throw(RuntimeError("killed"))
    )
    crashing.subscribe()
    try:
        with pytest.raises(RuntimeError):
            while True:
                crashing.step()
    finally:
        crashing.close()
    keys_after_crash = set(list_objects(settings))
    assert keys_after_crash

    service = ConsumerService(engine, settings, BronzeProcessor(settings), instance="b2")
    service.subscribe()
    try:
        consume_until(service, len(ops_demo.events))
        objects = list_objects(settings)
        # Reprocessing the same offset range rewrote the same keys: no duplicate objects.
        assert set(objects) == keys_after_crash
        with engine.connect() as conn:
            manifest = {r["object_key"]: r for r in conn.execute(select(bronze_objects)).mappings()}
        assert set(manifest) == set(objects)
        assert all(manifest[k]["size_bytes"] == size for k, size in objects.items())
        rows = bronze_rows(settings)
        assert len(rows) == len(ops_demo.events)
        assert sorted(json.loads(r["envelope_json"])["sequence"] for r in rows) == list(
            range(1, len(ops_demo.events) + 1)
        )
        for key in objects:
            event_date = key.split("event_date=")[1][:10]
            event_type = key.split("event_type=")[1].split("/")[0]
            for r in read_object(settings, key).to_pylist():
                envelope = json.loads(r["envelope_json"])
                assert envelope["occurred_at"][:10] == event_date
                assert envelope["event_type"] == event_type
                assert r["source"] == "kafka" and r["kafka_offset"] is not None

        # Redelivered records are kept (auditable), so bronze has more rows than distinct events.
        redeliver_first(engine, settings, 40)
        consume_until(service, len(ops_demo.events) + 40)
        rows = bronze_rows(settings)
        assert len(rows) == len(ops_demo.events) + 40
        assert len({r["event_id"] for r in rows}) == len(ops_demo.events)
    finally:
        service.close()


def test_object_store_outage_rewinds_instead_of_dead_lettering(
    engine: Engine, ops_demo: RunFixture
) -> None:
    good = lake_settings(consumer_retry_attempts=2)
    ensure_bucket(good)
    publish_run(engine, good, ops_demo)
    down = good.model_copy(update={"s3_endpoint": "127.0.0.1:1"})
    failing = ConsumerService(engine, down, BronzeProcessor(down), instance="b3")
    failing.subscribe()
    try:
        with pytest.raises(OSError):
            while True:
                failing.step()
    finally:
        failing.close()
    assert count(engine, dead_letters) == 0 and count(engine, bronze_objects) == 0

    service = ConsumerService(engine, good, BronzeProcessor(good), instance="b4")
    service.subscribe()
    try:
        consume_until(service, len(ops_demo.events))
    finally:
        service.close()
    assert len(bronze_rows(good)) == len(ops_demo.events)


def test_bronze_rebuild_from_postgres_is_complete_and_idempotent(
    engine: Engine, ops_demo: RunFixture
) -> None:
    settings = lake_settings()
    ensure_bucket(settings)
    store_run(engine, ops_demo, settings.kafka_events_topic)
    day = date.fromisoformat(ops_demo.events[0]["occurred_at"][:10])
    first = rebuild_from_postgres(engine, settings, day, day)
    second = rebuild_from_postgres(engine, settings, day, day)
    assert [o.key for o in first] == [o.key for o in second]
    rows = bronze_rows(settings)
    assert [json.loads(r["envelope_json"]) for r in sorted(rows, key=lambda r: r["sequence"])] == (
        ops_demo.events
    )
    assert {r["source"] for r in rows} == {"postgres-rebuild"}
    assert count(engine, bronze_objects) == len(first)
