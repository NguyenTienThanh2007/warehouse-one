"""Pipeline logic that needs no infrastructure: record validation, Parquet layout and naming."""

import io
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
import pytest

from warehouse_api.ingest.canonical import canonical_json, sha256_hex
from warehouse_pipeline.consumer import DeadLetter, Record, ValidRecord, validate
from warehouse_pipeline.lake import (
    BRONZE_SCHEMA,
    BronzeRow,
    kafka_name,
    object_key,
    rebuild_name,
    to_table,
)
from warehouse_pipeline.relay import backoff_s


@pytest.fixture
def events(repo_root: Path) -> list[dict[str, Any]]:
    lines = (repo_root / "data/fixtures/operations-demo/events.jsonl").read_text().splitlines()
    return [json.loads(line) for line in lines]


def rec(value: bytes | None, offset: int = 7) -> Record:
    return Record("t", 2, offset, b"k", value, {})


def test_valid_records_carry_the_canonical_envelope(events: list[dict[str, Any]]) -> None:
    out = validate(rec(json.dumps(events[0]).encode()))
    assert isinstance(out, ValidRecord)
    assert out.envelope == events[0]
    assert out.envelope_sha256 == sha256_hex(canonical_json(events[0]))
    assert out.event.sequence == events[0]["sequence"]


@pytest.mark.parametrize(
    ("value", "error_class"),
    [
        (None, "empty_message"),
        (b"\xff\xfe not utf-8", "undecodable"),
        (b"{not json", "undecodable"),
        (b'{"event_type": "inventory.teleported"}', "contract_violation"),
    ],
)
def test_invalid_records_become_dead_letters(value: bytes | None, error_class: str) -> None:
    out = validate(rec(value))
    assert isinstance(out, DeadLetter)
    assert out.error_class == error_class
    assert out.record.offset == 7 and out.record.value == value


def test_contract_violation_keeps_identifiers_when_parseable(events: list[dict[str, Any]]) -> None:
    broken = dict(events[3]) | {"aggregate_version": 0}
    out = validate(rec(json.dumps(broken).encode()))
    assert isinstance(out, DeadLetter) and out.error_class == "contract_violation"
    assert out.event_id == events[3]["event_id"]
    assert "aggregate_version" in out.error_detail


def test_parquet_round_trip_is_lossless(events: list[dict[str, Any]]) -> None:
    rows = [
        BronzeRow(
            envelope=e,
            envelope_json=canonical_json(e).decode(),
            envelope_sha256=sha256_hex(canonical_json(e)),
            source="kafka",
            kafka_topic="t",
            kafka_partition=1,
            kafka_offset=i,
        )
        for i, e in enumerate(events)
    ]
    stamp = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)
    buf = io.BytesIO()
    pq.write_table(to_table(rows, stamp), buf)
    table = pq.read_table(io.BytesIO(buf.getvalue()))
    assert table.schema.equals(BRONZE_SCHEMA, check_metadata=False)
    back = table.to_pylist()
    assert [json.loads(r["envelope_json"]) for r in back] == events
    assert [json.loads(r["payload_json"]) for r in back] == [e["payload"] for e in events]
    assert [r["sequence"] for r in back] == [e["sequence"] for e in events]
    assert back[0]["occurred_at"].isoformat().startswith(events[0]["occurred_at"][:19])
    assert {r["ingested_at"] for r in back} == {stamp}
    assert [r["kafka_offset"] for r in back] == list(range(len(events)))


def test_object_names_are_deterministic_and_partitioned(events: list[dict[str, Any]]) -> None:
    row = BronzeRow(events[0], "{}", "x", "kafka", "warehouse.domain-events.v1", 3, 41)
    row2 = BronzeRow(events[1], "{}", "y", "kafka", "warehouse.domain-events.v1", 3, 57)
    assert (
        kafka_name([row, row2]) == "part-warehouse_domain-events_v1-p3-o000000000041-000000000057"
    )
    assert kafka_name([row2, row]) == kafka_name([row, row2])
    rebuilt = BronzeRow(events[0], "{}", "x", "postgres-rebuild")
    assert rebuild_name([rebuilt]).startswith(
        f"part-rebuild-{events[0]['simulation_id']}-s000000001"
    )
    key = object_key(row.event_date, row.event_type, "n")
    date, kind = events[0]["occurred_at"][:10], events[0]["event_type"]
    assert key == f"bronze/domain_events/event_date={date}/event_type={kind}/n.parquet"


def test_backoff_is_bounded() -> None:
    assert backoff_s(1, 0.5, 30) == 0.5 and backoff_s(30, 0.5, 30) == 30
