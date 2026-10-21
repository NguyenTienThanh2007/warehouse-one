"""Configuration for the data-platform services (relay, consumers, bronze, reconciliation).

Every value can be overridden with a WAREHOUSE_* environment variable. Defaults are for local
development only (single broker, replication factor 1, MinIO with development credentials supplied
by the environment, never committed).
"""

import os
import socket
from functools import lru_cache

from pydantic import Field, PostgresDsn, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


def _instance() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


class PipelineSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WAREHOUSE_", env_file=".env", extra="ignore")

    log_level: str = "INFO"
    database_url: PostgresDsn = PostgresDsn(
        "postgresql+psycopg://warehouse:warehouse_dev@localhost:5432/warehouse_one"
    )
    instance_id: str = Field(default_factory=_instance)

    # Kafka (DEC-026). Partitions/replication/retention apply when topics are created.
    kafka_bootstrap_servers: str = "localhost:9092"
    kafka_events_topic: str = "warehouse.domain-events.v1"
    kafka_dlq_topic: str = "warehouse.domain-events.v1.dlq"
    kafka_events_partitions: int = Field(default=6, ge=1)
    kafka_replication_factor: int = Field(default=1, ge=1)  # development: single broker
    kafka_events_retention_ms: int = 7 * 24 * 3600 * 1000
    kafka_dlq_retention_ms: int = 30 * 24 * 3600 * 1000
    kafka_delivery_timeout_ms: int = Field(default=15_000, ge=1000)

    # Outbox relay (DEC-025).
    relay_batch_size: int = Field(default=500, ge=1, le=5000)
    relay_lease_s: float = Field(default=30.0, gt=0)
    relay_idle_sleep_s: float = Field(default=0.5, gt=0)
    relay_backoff_base_s: float = Field(default=1.0, gt=0)
    relay_backoff_max_s: float = Field(default=60.0, gt=0)

    # Consumers (DEC-027).
    consumer_batch_size: int = Field(default=500, ge=1, le=10_000)
    consumer_batch_timeout_s: float = Field(default=2.0, gt=0)
    consumer_retry_attempts: int = Field(default=5, ge=1)
    consumer_backoff_base_s: float = Field(default=0.5, gt=0)
    consumer_backoff_max_s: float = Field(default=30.0, gt=0)

    # Object store (DEC-028, DEC-031): any S3-compatible endpoint.
    s3_endpoint: str = "localhost:9000"
    s3_scheme: str = "http"
    s3_region: str = "us-east-1"
    s3_access_key: SecretStr = SecretStr("")
    s3_secret_key: SecretStr = SecretStr("")
    lake_bucket: str = "warehouse-lake"

    heartbeat_interval_s: float = Field(default=5.0, gt=0)

    @property
    def sqlalchemy_url(self) -> str:
        return str(self.database_url)


@lru_cache
def get_pipeline_settings() -> PipelineSettings:
    return PipelineSettings()
