"""Environment-based configuration. Every setting can be overridden with a WAREHOUSE_* variable."""

from enum import StrEnum
from functools import lru_cache

from pydantic import Field, PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict

# Any loopback web origin, on any port: localhost, 127.0.0.1 or [::1].
LOOPBACK_ORIGIN = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$"


class Environment(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WAREHOUSE_", env_file=".env", extra="ignore")

    env: Environment = Environment.DEVELOPMENT
    log_level: str = "INFO"
    # Local development default only; deployments must set WAREHOUSE_DATABASE_URL.
    database_url: PostgresDsn = PostgresDsn(
        "postgresql+psycopg://warehouse:warehouse_dev@localhost:5432/warehouse_one"
    )
    database_connect_timeout_s: int = Field(default=3, ge=1, le=30)
    cors_origins: list[str] = ["http://localhost:3000"]
    # Development only: also accept any loopback origin, so a web dev server that lands on another
    # port (3001 when 3000 is taken, 3100 for the browser tests) is not blocked by CORS while the
    # API is reachable. Never applies outside development, where only cors_origins are allowed.
    cors_allow_loopback: bool = True
    git_sha: str = "unknown"
    # Largest accepted request body for the ingestion API (a full batch is well below this).
    max_request_bytes: int = Field(default=4 * 1024 * 1024, ge=1024)
    # Kafka topic recorded on outbox rows (DEC-026).
    kafka_events_topic: str = "warehouse.domain-events.v1"
    # Analytics read API (Phase 4): a snapshot older than this is reported as stale (the refresh
    # DAG publishes every 30 minutes), and a pipeline heartbeat older than this is unhealthy.
    analytics_stale_after_s: int = Field(default=2 * 3600, ge=60)
    analytics_heartbeat_max_age_s: int = Field(default=120, ge=10)

    @property
    def cors_origin_regex(self) -> str | None:
        if self.env is Environment.DEVELOPMENT and self.cors_allow_loopback:
            return LOOPBACK_ORIGIN
        return None

    @property
    def expose_error_details(self) -> bool:
        return self.env is not Environment.PRODUCTION


@lru_cache
def get_settings() -> Settings:
    return Settings()
