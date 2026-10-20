"""Database engine and connectivity checks. Domain tables arrive with Phase 3 (outbox, events)."""

import time
from dataclasses import dataclass
from functools import lru_cache

from sqlalchemy import Engine, create_engine, text

from warehouse_api.config import get_settings


@lru_cache
def get_engine() -> Engine:
    settings = get_settings()
    return create_engine(
        str(settings.database_url),
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=5,
        connect_args={"connect_timeout": settings.database_connect_timeout_s},
    )


@dataclass(frozen=True)
class DatabaseStatus:
    ok: bool
    latency_ms: float | None
    error: str | None = None


def check_database(engine: Engine) -> DatabaseStatus:
    started = time.perf_counter()
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:  # any failure means "not ready"
        return DatabaseStatus(ok=False, latency_ms=None, error=type(exc).__name__)
    return DatabaseStatus(ok=True, latency_ms=round((time.perf_counter() - started) * 1000, 2))
