"""Component heartbeats in PostgreSQL: a running loop that can reach the database and its
dependencies writes `ok`; one that cannot reach a dependency writes `degraded` with the reason.
Health checks read these rows, so a container is healthy only while its work loop is.
"""

import time
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Engine, select
from sqlalchemy.dialects.postgresql import insert

from warehouse_api.store.tables import heartbeats


class Heartbeat:
    def __init__(self, engine: Engine, component: str, instance: str, interval_s: float) -> None:
        self.engine = engine
        self.component = component
        self.instance = instance
        self.interval_s = interval_s
        self._last = 0.0

    def due(self) -> bool:
        return time.monotonic() - self._last >= self.interval_s

    def beat(self, status: str, details: dict[str, Any], force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last < self.interval_s:
            return
        stmt = insert(heartbeats).values(
            component=self.component, instance=self.instance, status=status, details=details
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["component", "instance"],
            set_={"status": status, "details": details, "last_beat_at": datetime.now(UTC)},
        )
        with self.engine.begin() as conn:
            conn.execute(stmt)
        self._last = now


def check(engine: Engine, component: str, max_age_s: float) -> tuple[bool, list[dict[str, Any]]]:
    """Healthy when at least one instance beat recently with status `ok`."""
    with engine.connect() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                select(heartbeats).where(heartbeats.c.component == component)
            ).mappings()
        ]
    cutoff = datetime.now(UTC) - timedelta(seconds=max_age_s)
    fresh_ok = [r for r in rows if r["last_beat_at"] >= cutoff and r["status"] == "ok"]
    report = [
        {
            "instance": r["instance"],
            "status": r["status"],
            "age_s": round((datetime.now(UTC) - r["last_beat_at"]).total_seconds(), 1),
            "details": r["details"],
        }
        for r in rows
    ]
    return bool(fresh_ok), report
