"""Kafka consumer loop with manual commits, contract validation and a durable DLQ (DEC-027).

For each polled batch:
1. Decode and validate every record against the event contract. Undecodable or invalid records
   become dead letters; they are never dropped silently.
2. One short database transaction: the processor does its durable work for the valid records and
   may dead-letter more (for example a conflicting duplicate); every dead letter is recorded in
   `pipeline.dead_letters` (unique per source offset) in the same transaction.
3. Outside the transaction, dead letters are produced to the DLQ topic and their DLQ coordinates
   recorded.
4. Only then are the offsets committed (synchronously).

Every step is idempotent, so a crash at any point means the batch is processed again from the last
committed offsets: the processor's writes are keyed by `event_id` / object key, dead-letter rows by
source offset, and DLQ copies may be produced more than once (at-least-once, like the main topic).

Infrastructure failures (database, object store, DLQ producer) are retried with bounded exponential
backoff. When the budget is exhausted the consumer rewinds to the first uncommitted offsets, reports
`degraded` and tries again later: such records are never dead-lettered and never skipped.
"""

import base64
import json
import logging
import signal
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from confluent_kafka import Consumer, KafkaError, Message, Producer, TopicPartition
from pydantic import ValidationError
from sqlalchemy import Connection, Engine, update
from sqlalchemy.dialects.postgresql import insert

from warehouse_api.contracts.events import AnyEvent, parse_event
from warehouse_api.ingest.canonical import canonical_json, sha256_hex
from warehouse_api.store.tables import dead_letters
from warehouse_pipeline.heartbeat import Heartbeat
from warehouse_pipeline.kafka import producer
from warehouse_pipeline.relay import backoff_s
from warehouse_pipeline.settings import PipelineSettings

log = logging.getLogger("warehouse_pipeline.consumer")


@dataclass(frozen=True)
class Record:
    topic: str
    partition: int
    offset: int
    key: bytes | None
    value: bytes | None
    headers: dict[str, str]


@dataclass(frozen=True)
class ValidRecord:
    record: Record
    event: AnyEvent
    envelope: dict[str, Any]
    envelope_json: str
    envelope_sha256: str


@dataclass(frozen=True)
class DeadLetter:
    record: Record
    error_class: str
    error_detail: str
    event_id: str | None = None
    simulation_id: str | None = None


@dataclass
class ProcessResult:
    dead_letters: list[DeadLetter] = field(default_factory=list)
    counters: dict[str, int] = field(default_factory=dict)


class Processor(Protocol):
    group: str

    def process(self, conn: Connection, records: list[ValidRecord]) -> ProcessResult:
        """Do the durable work for `records` inside `conn`'s transaction (idempotently) and return
        any records that must be dead-lettered, plus counters for logs and health."""
        ...


def validate(record: Record) -> ValidRecord | DeadLetter:
    if record.value is None:
        return DeadLetter(record, "empty_message", "message has no value")
    try:
        text = record.value.decode("utf-8")
        envelope = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return DeadLetter(record, "undecodable", f"{type(exc).__name__}: {exc}")
    event_id = str(envelope.get("event_id")) if isinstance(envelope, dict) else None
    simulation_id = str(envelope.get("simulation_id")) if isinstance(envelope, dict) else None
    try:
        event = parse_event(record.value)
    except ValidationError as exc:
        detail = "; ".join(
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()[:5]
        )
        return DeadLetter(record, "contract_violation", detail, event_id, simulation_id)
    canonical = canonical_json(envelope)
    return ValidRecord(
        record=record,
        event=event,
        envelope=envelope,
        envelope_json=canonical.decode(),
        envelope_sha256=sha256_hex(canonical),
    )


class ConsumerService:
    def __init__(
        self,
        engine: Engine,
        settings: PipelineSettings,
        processor: Processor,
        instance: str | None = None,
        dlq_producer: Producer | None = None,
    ) -> None:
        self.engine = engine
        self.settings = settings
        self.processor = processor
        self.instance = instance or settings.instance_id
        self.consumer = Consumer(
            {
                "bootstrap.servers": settings.kafka_bootstrap_servers,
                "group.id": processor.group,
                "client.id": f"{processor.group}-{self.instance}",
                "enable.auto.commit": False,
                "auto.offset.reset": "earliest",
                "isolation.level": "read_committed",
                "max.poll.interval.ms": 300_000,
            }
        )
        self.dlq = dlq_producer or producer(settings, f"dlq-{processor.group}-{self.instance}")
        self.stop_event = threading.Event()
        self.heartbeat = Heartbeat(
            engine, f"consumer-{processor.group}", self.instance, settings.heartbeat_interval_s
        )
        self.totals: dict[str, int] = {"records": 0, "dead_letters": 0, "batches": 0}
        self.last_error: str | None = None

    # Batch handling ------------------------------------------------------------------------

    def poll_batch(self) -> list[Record]:
        messages = self.consumer.consume(
            num_messages=self.settings.consumer_batch_size,
            timeout=self.settings.consumer_batch_timeout_s,
        )
        out: list[Record] = []
        for msg in messages:
            err = msg.error()
            if err is not None:
                if err.code() == KafkaError._PARTITION_EOF:
                    continue
                raise RuntimeError(f"consumer error: {err}")
            out.append(_record(msg))
        return out

    def handle(self, batch: list[Record]) -> ProcessResult:
        """Process one batch end to end (idempotent): validate, process, dead-letter."""
        valid: list[ValidRecord] = []
        dead: list[DeadLetter] = []
        for record in batch:
            outcome = validate(record)
            if isinstance(outcome, ValidRecord):
                valid.append(outcome)
            else:
                dead.append(outcome)
        with self.engine.begin() as conn:
            result = self.processor.process(conn, valid)
            dead.extend(result.dead_letters)
            self._store_dead(conn, dead)
        if dead:
            sent = self._produce_dead(dead)
            with self.engine.begin() as conn:
                for (topic, partition, offset), (dlq_partition, dlq_offset) in sent.items():
                    conn.execute(
                        update(dead_letters)
                        .where(
                            dead_letters.c.consumer_group == self.processor.group,
                            dead_letters.c.source_topic == topic,
                            dead_letters.c.source_partition == partition,
                            dead_letters.c.source_offset == offset,
                        )
                        .values(dlq_partition=dlq_partition, dlq_offset=dlq_offset)
                    )
        result.dead_letters = dead
        return result

    def commit(self, batch: list[Record]) -> None:
        last: dict[tuple[str, int], int] = {}
        for r in batch:
            last[(r.topic, r.partition)] = max(last.get((r.topic, r.partition), -1), r.offset)
        offsets = [TopicPartition(t, p, o + 1) for (t, p), o in sorted(last.items())]
        if offsets:
            self.consumer.commit(offsets=offsets, asynchronous=False)

    def rewind(self, batch: list[Record]) -> None:
        first: dict[tuple[str, int], int] = {}
        for r in batch:
            first[(r.topic, r.partition)] = min(
                first.get((r.topic, r.partition), r.offset), r.offset
            )
        for (t, p), o in first.items():
            self.consumer.seek(TopicPartition(t, p, o))

    def step(self) -> int:
        """Poll and fully process one batch. Returns the number of records handled."""
        batch = self.poll_batch()
        if not batch:
            return 0
        attempts = self.settings.consumer_retry_attempts
        for attempt in range(1, attempts + 1):
            try:
                result = self.handle(batch)
                break
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                log.warning(
                    "batch failed, retrying",
                    extra={
                        "group": self.processor.group,
                        "attempt": attempt,
                        "error": self.last_error,
                    },
                )
                if attempt == attempts:
                    self.rewind(batch)
                    self._beat(degraded=True)
                    raise
                self.stop_event.wait(
                    backoff_s(
                        attempt,
                        self.settings.consumer_backoff_base_s,
                        self.settings.consumer_backoff_max_s,
                    )
                )
        self.commit(batch)
        self.totals["records"] += len(batch)
        self.totals["batches"] += 1
        self.totals["dead_letters"] += len(result.dead_letters)
        for k, v in result.counters.items():
            self.totals[k] = self.totals.get(k, 0) + v
        self.last_error = None
        return len(batch)

    def subscribe(self) -> None:
        self.consumer.subscribe([self.settings.kafka_events_topic])

    def close(self) -> None:
        self.consumer.close()

    def run_forever(self) -> None:
        self.subscribe()
        log.info("consumer started", extra={"group": self.processor.group})
        while not self.stop_event.is_set():
            try:
                self.step()
                self._beat()
            except Exception:
                log.exception("batch failed after retries; will retry from the same offsets")
                self.stop_event.wait(self.settings.consumer_backoff_max_s)
        self._beat(stopping=True)
        self.consumer.close()  # leaves the group; uncommitted work is redelivered to others
        log.info("consumer stopped", extra={"group": self.processor.group, "totals": self.totals})

    # Dead letters ---------------------------------------------------------------------------

    def _produce_dead(self, dead: list[DeadLetter]) -> dict[tuple[str, int, int], tuple[int, int]]:
        results: dict[tuple[str, int, int], tuple[int, int] | str] = {}
        for d in dead:
            r = d.record
            body = {
                "consumer_group": self.processor.group,
                "error_class": d.error_class,
                "error_detail": d.error_detail,
                "event_id": d.event_id,
                "simulation_id": d.simulation_id,
                "source": {"topic": r.topic, "partition": r.partition, "offset": r.offset},
                "original_headers": r.headers,
                "original_value_base64": base64.b64encode(r.value).decode() if r.value else None,
                "failed_at": datetime.now(UTC).isoformat(),
            }
            ident = (r.topic, r.partition, r.offset)

            def cb(
                err: KafkaError | None, msg: Message, ident: tuple[str, int, int] = ident
            ) -> None:
                if err is not None:
                    results[ident] = str(err)
                else:
                    results[ident] = (msg.partition() or 0, msg.offset() or 0)

            self.dlq.produce(
                self.settings.kafka_dlq_topic,
                key=r.key,
                value=json.dumps(body).encode(),
                headers=[
                    ("error_class", d.error_class.encode()),
                    ("consumer_group", self.processor.group.encode()),
                ],
                on_delivery=cb,
            )
        if dead:
            self.dlq.flush(self.settings.kafka_delivery_timeout_ms / 1000 + 5)
        failed = {k: v for k, v in results.items() if not isinstance(v, tuple)}
        if failed or len(results) < len(dead):
            raise RuntimeError(f"DLQ produce failed: {failed or 'no delivery report'}")
        return {k: v for k, v in results.items() if isinstance(v, tuple)}

    def _store_dead(self, conn: Connection, dead: list[DeadLetter]) -> None:
        if not dead:
            return
        stmt = insert(dead_letters).on_conflict_do_nothing(
            index_elements=["consumer_group", "source_topic", "source_partition", "source_offset"]
        )
        conn.execute(
            stmt,
            [
                {
                    "consumer_group": self.processor.group,
                    "error_class": d.error_class,
                    "error_detail": d.error_detail[:4000],
                    "event_id": d.event_id,
                    "simulation_id": d.simulation_id,
                    "source_topic": d.record.topic,
                    "source_partition": d.record.partition,
                    "source_offset": d.record.offset,
                    "message_key": d.record.key,
                    "message_value": d.record.value,
                    "headers": d.record.headers,
                    "dlq_topic": self.settings.kafka_dlq_topic,
                }
                for d in dead
            ],
        )

    # Health -------------------------------------------------------------------------------

    def lag(self) -> int | None:
        try:
            total = 0
            for tp in self.consumer.assignment():
                low, high = self.consumer.get_watermark_offsets(tp, timeout=3, cached=False)
                committed = self.consumer.committed([tp], timeout=3)[0].offset
                position = committed if committed >= 0 else low
                total += max(0, high - position)
            return total
        except Exception:
            return None

    def _beat(self, degraded: bool = False, stopping: bool = False) -> None:
        if not (degraded or stopping or self.heartbeat.due()):
            return
        try:
            details: dict[str, Any] = dict(self.totals)
            details["last_error"] = self.last_error
            details["lag"] = None if stopping else self.lag()
            status = "stopping" if stopping else ("degraded" if degraded else "ok")
            self.heartbeat.beat(status, details, force=True)
        except Exception:
            log.exception("heartbeat failed")

    def install_signal_handlers(self) -> None:
        def stop(signum: int, _frame: object) -> None:
            log.info("signal received, stopping", extra={"signal": signum})
            self.stop_event.set()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)


def _record(msg: Message) -> Record:
    return Record(
        topic=msg.topic() or "",
        partition=msg.partition() or 0,
        offset=msg.offset() or 0,
        key=msg.key(),
        value=msg.value(),
        headers=_headers(msg.headers()),
    )


def _headers(raw: Any) -> dict[str, str]:
    if not raw:
        return {}
    items = raw.items() if isinstance(raw, dict) else raw
    return {str(k): _text(v) for k, v in items}


def _text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    return value.decode(errors="replace") if isinstance(value, bytes) else value
