"""Kafka clients and topic administration (DEC-026)."""

import logging

from confluent_kafka import KafkaException, Producer
from confluent_kafka.admin import AdminClient
from confluent_kafka.cimpl import NewTopic

from warehouse_pipeline.settings import PipelineSettings

log = logging.getLogger("warehouse_pipeline.kafka")


def admin(settings: PipelineSettings) -> AdminClient:
    return AdminClient({"bootstrap.servers": settings.kafka_bootstrap_servers})


def producer(settings: PipelineSettings, client_id: str) -> Producer:
    """Idempotent producer: acks from all in-sync replicas, ordering preserved under retries."""
    return Producer(
        {
            "bootstrap.servers": settings.kafka_bootstrap_servers,
            "client.id": client_id,
            "enable.idempotence": True,
            "acks": "all",
            "linger.ms": 5,
            "compression.type": "lz4",
            "delivery.timeout.ms": settings.kafka_delivery_timeout_ms,
            "request.timeout.ms": min(10_000, settings.kafka_delivery_timeout_ms),
        }
    )


def ensure_topics(settings: PipelineSettings, timeout_s: float = 30.0) -> dict[str, str]:
    """Create the event and DLQ topics if missing (idempotent). Returns topic -> outcome."""
    client = admin(settings)
    existing = client.list_topics(timeout=timeout_s).topics
    wanted = {
        settings.kafka_events_topic: NewTopic(
            settings.kafka_events_topic,
            num_partitions=settings.kafka_events_partitions,
            replication_factor=settings.kafka_replication_factor,
            config={
                "cleanup.policy": "delete",
                "retention.ms": str(settings.kafka_events_retention_ms),
                "min.insync.replicas": "1",
            },
        ),
        settings.kafka_dlq_topic: NewTopic(
            settings.kafka_dlq_topic,
            num_partitions=1,
            replication_factor=settings.kafka_replication_factor,
            config={
                "cleanup.policy": "delete",
                "retention.ms": str(settings.kafka_dlq_retention_ms),
                "min.insync.replicas": "1",
            },
        ),
    }
    outcome: dict[str, str] = {}
    to_create = [t for name, t in wanted.items() if name not in existing]
    for name in wanted:
        if name in existing:
            partitions = len(existing[name].partitions)
            outcome[name] = f"exists ({partitions} partitions)"
    if to_create:
        for name, future in client.create_topics(to_create, operation_timeout=timeout_s).items():
            try:
                future.result()
                outcome[name] = "created"
            except KafkaException as exc:
                if "TOPIC_ALREADY_EXISTS" in str(exc):
                    outcome[name] = "exists"
                else:
                    raise
    log.info("topics", extra={"topics": outcome})
    return outcome


def broker_reachable(settings: PipelineSettings, timeout_s: float = 5.0) -> bool:
    try:
        admin(settings).list_topics(timeout=timeout_s)
    except KafkaException:
        return False
    return True
