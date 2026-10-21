"""Helpers for tests that need a Kafka broker (WAREHOUSE_KAFKA_BOOTSTRAP_SERVERS)."""

import time
import uuid
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from confluent_kafka import Consumer, KafkaError
from sqlalchemy import Engine

from tests.integration.conftest import RunFixture
from warehouse_api.ingest.service import BatchRequest, RunRegistration, ingest_batch, register_run
from warehouse_pipeline.settings import PipelineSettings


@dataclass(frozen=True)
class Delivered:
    topic: str
    partition: int
    offset: int
    key: bytes | None
    value: bytes
    headers: dict[str, bytes]


def isolated_settings(**overrides: Any) -> PipelineSettings:
    """Settings for a test with its own topics, so tests never see each other's messages."""
    suffix = uuid.uuid4().hex[:8]
    base: dict[str, Any] = {
        "kafka_events_topic": f"test.events.{suffix}",
        "kafka_dlq_topic": f"test.events.{suffix}.dlq",
        "kafka_events_partitions": 3,
        "kafka_delivery_timeout_ms": 5000,
        "relay_backoff_base_s": 0.2,
        "relay_backoff_max_s": 1.0,
        "relay_idle_sleep_s": 0.05,
        "heartbeat_interval_s": 0.2,
        "consumer_batch_timeout_s": 0.5,
        "consumer_backoff_base_s": 0.05,
        "consumer_backoff_max_s": 0.2,
    }
    return PipelineSettings(**(base | overrides))


def store_run(engine: Engine, run: RunFixture, topic: str, batch: int = 50) -> UUID:
    """Register and ingest a fixture run through the real ingestion service."""
    simulation_id = UUID(run.simulation_id)
    with engine.begin() as conn:
        register_run(
            conn,
            RunRegistration(
                simulation_id=simulation_id,
                config=run.config,
                engine_version="0.1.0",
                scenario_id=None,
                source="test",
            ),
        )
    for b in run.batches(batch):
        with engine.begin() as conn:
            ingest_batch(
                conn,
                BatchRequest(
                    simulation_id=simulation_id,
                    batch_id=uuid.uuid4(),
                    through_tick=b["through_tick"],
                    commands=b["commands"],
                    events=b["events"],
                ),
                topic,
            )
    return simulation_id


def drain(
    settings: PipelineSettings, topic: str, expected: int, timeout_s: float = 30
) -> list[Delivered]:
    """Read a topic from the start with a throwaway group until `expected` messages or timeout."""
    consumer = Consumer(
        {
            "bootstrap.servers": settings.kafka_bootstrap_servers,
            "group.id": f"test-reader-{uuid.uuid4().hex[:8]}",
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
        }
    )
    consumer.subscribe([topic])
    out: list[Delivered] = []
    deadline = time.monotonic() + timeout_s
    try:
        while len(out) < expected and time.monotonic() < deadline:
            msg = consumer.poll(0.5)
            if msg is None:
                continue
            err = msg.error()
            if err is not None:
                if err.code() == KafkaError._PARTITION_EOF:
                    continue
                raise RuntimeError(str(err))
            out.append(
                Delivered(
                    topic=msg.topic() or "",
                    partition=msg.partition() or 0,
                    offset=msg.offset() or 0,
                    key=msg.key(),
                    value=msg.value() or b"",
                    headers={k: v or b"" for k, v in (msg.headers() or [])},
                )
            )
    finally:
        consumer.close()
    return out
