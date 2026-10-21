"""Bronze lake on S3-compatible storage: Parquet layout, writing and reading (DEC-028).

Layout: s3://<bucket>/bronze/domain_events/event_date=YYYY-MM-DD/event_type=<type>/<name>.parquet

- `event_date` is the simulated business date of `occurred_at` (UTC), not the ingestion date.
- Names are deterministic: `part-<topic>-p<partition>-o<first>-<last>` for Kafka batches (the same
  offset range always maps to the same key) and `part-rebuild-<simulation_id>-s<first>-<last>` for
  rebuilds from the PostgreSQL event log.
- Every delivered record is kept, including redeliveries: bronze is the audit trail; silver
  deduplicates by `event_id`.
"""

import hashlib
import io
import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
from pyarrow import fs

from warehouse_pipeline import __version__
from warehouse_pipeline.settings import PipelineSettings

BRONZE_PREFIX = "bronze/domain_events"

BRONZE_SCHEMA = pa.schema(
    [
        pa.field("event_id", pa.string(), nullable=False),
        pa.field("event_type", pa.string(), nullable=False),
        pa.field("schema_version", pa.int32(), nullable=False),
        pa.field("aggregate_type", pa.string(), nullable=False),
        pa.field("aggregate_id", pa.string(), nullable=False),
        pa.field("aggregate_version", pa.int64(), nullable=False),
        pa.field("simulation_id", pa.string(), nullable=False),
        pa.field("sequence", pa.int64(), nullable=False),
        pa.field("occurred_at", pa.timestamp("ms", tz="UTC"), nullable=False),
        pa.field("simulation_time_ms", pa.int64(), nullable=False),
        pa.field("correlation_id", pa.string(), nullable=False),
        pa.field("causation_id", pa.string(), nullable=False),
        pa.field("payload_json", pa.string(), nullable=False),
        pa.field("envelope_json", pa.string(), nullable=False),
        pa.field("envelope_sha256", pa.string(), nullable=False),
        # Ingestion metadata (operational, wall clock).
        pa.field("source", pa.string(), nullable=False),
        pa.field("kafka_topic", pa.string()),
        pa.field("kafka_partition", pa.int32()),
        pa.field("kafka_offset", pa.int64()),
        pa.field("ingested_at", pa.timestamp("ms", tz="UTC"), nullable=False),
        pa.field("pipeline_version", pa.string(), nullable=False),
    ],
    metadata={"layout": "warehouse-one bronze v1", "partitioning": "event_date/event_type"},
)


@dataclass(frozen=True)
class BronzeRow:
    envelope: dict[str, Any]
    envelope_json: str
    envelope_sha256: str
    source: str
    kafka_topic: str | None = None
    kafka_partition: int | None = None
    kafka_offset: int | None = None

    @property
    def event_date(self) -> str:
        return str(self.envelope["occurred_at"])[:10]

    @property
    def event_type(self) -> str:
        return str(self.envelope["event_type"])


@dataclass(frozen=True)
class BronzeObject:
    key: str
    event_date: str
    event_type: str
    record_count: int
    size_bytes: int
    sha256: str
    source: str
    kafka_topic: str | None
    kafka_partition: int | None
    first_offset: int | None
    last_offset: int | None


def filesystem(settings: PipelineSettings) -> fs.S3FileSystem:
    return fs.S3FileSystem(
        access_key=settings.s3_access_key.get_secret_value(),
        secret_key=settings.s3_secret_key.get_secret_value(),
        endpoint_override=settings.s3_endpoint,
        scheme=settings.s3_scheme,
        region=settings.s3_region,
        allow_bucket_creation=True,
        connect_timeout=5,
        request_timeout=20,
    )


def ensure_bucket(settings: PipelineSettings) -> None:
    filesystem(settings).create_dir(settings.lake_bucket)


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def to_table(rows: list[BronzeRow], ingested_at: datetime) -> pa.Table:
    columns: dict[str, list[Any]] = defaultdict(list)
    for r in rows:
        e = r.envelope
        columns["event_id"].append(str(e["event_id"]))
        columns["event_type"].append(str(e["event_type"]))
        columns["schema_version"].append(int(e["schema_version"]))
        columns["aggregate_type"].append(str(e["aggregate_type"]))
        columns["aggregate_id"].append(str(e["aggregate_id"]))
        columns["aggregate_version"].append(int(e["aggregate_version"]))
        columns["simulation_id"].append(str(e["simulation_id"]))
        columns["sequence"].append(int(e["sequence"]))
        columns["occurred_at"].append(_parse_ts(str(e["occurred_at"])))
        columns["simulation_time_ms"].append(int(e["simulation_time_ms"]))
        columns["correlation_id"].append(str(e["correlation_id"]))
        columns["causation_id"].append(str(e["causation_id"]))
        columns["payload_json"].append(
            json.dumps(e["payload"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        )
        columns["envelope_json"].append(r.envelope_json)
        columns["envelope_sha256"].append(r.envelope_sha256)
        columns["source"].append(r.source)
        columns["kafka_topic"].append(r.kafka_topic)
        columns["kafka_partition"].append(r.kafka_partition)
        columns["kafka_offset"].append(r.kafka_offset)
        columns["ingested_at"].append(ingested_at)
        columns["pipeline_version"].append(__version__)
    return pa.table({f.name: columns[f.name] for f in BRONZE_SCHEMA}, schema=BRONZE_SCHEMA)


def object_key(event_date: str, event_type: str, name: str) -> str:
    return f"{BRONZE_PREFIX}/event_date={event_date}/event_type={event_type}/{name}.parquet"


def write_objects(
    settings: PipelineSettings,
    rows: list[BronzeRow],
    name_for: Any,
    ingested_at: datetime | None = None,
) -> list[BronzeObject]:
    """Write rows grouped by (partition key of `name_for`, event_date, event_type), one Parquet
    object per group. `name_for(group_rows)` returns the deterministic object name."""
    s3 = filesystem(settings)
    stamp = ingested_at or datetime.now(UTC)
    groups: dict[tuple[Any, str, str], list[BronzeRow]] = defaultdict(list)
    for r in rows:
        groups[
            (
                r.kafka_partition if r.source == "kafka" else r.envelope["simulation_id"],
                r.event_date,
                r.event_type,
            )
        ].append(r)
    written: list[BronzeObject] = []
    for (_, event_date, event_type), group in sorted(groups.items(), key=lambda kv: str(kv[0])):
        buf = io.BytesIO()
        pq.write_table(to_table(group, stamp), buf, compression="zstd")
        data = buf.getvalue()
        key = object_key(event_date, event_type, name_for(group))
        with s3.open_output_stream(f"{settings.lake_bucket}/{key}") as out:
            out.write(data)
        offsets = [r.kafka_offset for r in group if r.kafka_offset is not None]
        written.append(
            BronzeObject(
                key=key,
                event_date=event_date,
                event_type=event_type,
                record_count=len(group),
                size_bytes=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
                source=group[0].source,
                kafka_topic=group[0].kafka_topic,
                kafka_partition=group[0].kafka_partition,
                first_offset=min(offsets) if offsets else None,
                last_offset=max(offsets) if offsets else None,
            )
        )
    return written


def kafka_name(group: list[BronzeRow]) -> str:
    offsets = [r.kafka_offset or 0 for r in group]
    topic = (group[0].kafka_topic or "unknown").replace(".", "_")
    return f"part-{topic}-p{group[0].kafka_partition}-o{min(offsets):012d}-{max(offsets):012d}"


def rebuild_name(group: list[BronzeRow]) -> str:
    seqs = [int(r.envelope["sequence"]) for r in group]
    return f"part-rebuild-{group[0].envelope['simulation_id']}-s{min(seqs):09d}-{max(seqs):09d}"


def list_objects(settings: PipelineSettings) -> dict[str, int]:
    """Every bronze object key → size in bytes."""
    s3 = filesystem(settings)
    selector = fs.FileSelector(
        f"{settings.lake_bucket}/{BRONZE_PREFIX}", recursive=True, allow_not_found=True
    )
    prefix = f"{settings.lake_bucket}/"
    return {
        info.path[len(prefix) :]: info.size or 0
        for info in s3.get_file_info(selector)
        if info.type == fs.FileType.File and info.path.endswith(".parquet")
    }


def read_object(settings: PipelineSettings, key: str) -> pa.Table:
    return pq.read_table(f"{settings.lake_bucket}/{key}", filesystem=filesystem(settings))


def delete_object(settings: PipelineSettings, key: str) -> None:
    filesystem(settings).delete_file(f"{settings.lake_bucket}/{key}")
