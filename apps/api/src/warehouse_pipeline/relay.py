"""Transactional outbox relay: PostgreSQL outbox → Kafka (DEC-025, DEC-026).

Loop:
1. Claim one run with unpublished rows (lease on `simulation_runs`, `FOR UPDATE SKIP LOCKED`, short
   transaction). A run is relayed by at most one live relay, so its events are produced in order.
2. Read the run's next unpublished rows in `sequence` order (no transaction held afterwards).
3. Produce them with an idempotent producer (`acks=all`) and wait for every delivery report.
4. Mark published only the contiguous prefix of rows the broker acknowledged; record attempts and
   the error for the rest, set a bounded exponential backoff on the run, release the lease.

A crash between steps 3 and 4 leaves acknowledged rows unpublished in PostgreSQL; they are produced
again later. Consumers deduplicate (at-least-once delivery).
"""

import logging
import signal
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from confluent_kafka import KafkaError, Message, Producer
from sqlalchemy import Engine, bindparam, select, text, update

from warehouse_api.store.tables import outbox, simulation_runs
from warehouse_pipeline.heartbeat import Heartbeat
from warehouse_pipeline.kafka import broker_reachable, producer
from warehouse_pipeline.settings import PipelineSettings

log = logging.getLogger("warehouse_pipeline.relay")

CLAIM = text(
    """
    UPDATE operations.simulation_runs r
       SET relay_owner = :owner,
           relay_lease_until = now() + make_interval(secs => :lease_s)
     WHERE r.simulation_id = (
           SELECT c.simulation_id
             FROM operations.simulation_runs c
            WHERE EXISTS (SELECT 1 FROM operations.outbox o
                           WHERE o.simulation_id = c.simulation_id AND o.published_at IS NULL)
              AND (c.relay_lease_until IS NULL OR c.relay_lease_until < now()
                   OR c.relay_owner = :owner)
              AND (c.relay_next_attempt_at IS NULL OR c.relay_next_attempt_at <= now())
            ORDER BY c.relay_next_attempt_at NULLS FIRST, c.registered_at, c.simulation_id
            LIMIT 1
            FOR UPDATE SKIP LOCKED)
    RETURNING r.simulation_id, r.relay_failures
    """
)


@dataclass
class CycleResult:
    simulation_id: UUID | None = None
    attempted: int = 0
    published: int = 0
    error: str | None = None


@dataclass
class RelayStats:
    published_total: int = 0
    failed_cycles: int = 0
    last_error: str | None = None
    last_published_at: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def backoff_s(failures: int, base_s: float, max_s: float) -> float:
    """Delay after the n-th consecutive failure (n ≥ 1): base · 2^(n-1), capped at max."""
    return float(min(base_s * 2 ** max(0, failures - 1), max_s))


class OutboxRelay:
    def __init__(
        self,
        engine: Engine,
        settings: PipelineSettings,
        owner: str | None = None,
        kafka_producer: Producer | None = None,
    ) -> None:
        self.engine = engine
        self.settings = settings
        self.owner = owner or settings.instance_id
        self.producer = kafka_producer or producer(settings, f"outbox-relay-{self.owner}")
        self.stats = RelayStats()
        self.stop_event = threading.Event()
        self.heartbeat = Heartbeat(engine, "relay", self.owner, settings.heartbeat_interval_s)

    # One cycle ---------------------------------------------------------------------------------

    def claim(self) -> tuple[UUID, int] | None:
        with self.engine.begin() as conn:
            row = conn.execute(
                CLAIM, {"owner": self.owner, "lease_s": self.settings.relay_lease_s}
            ).first()
        return (row[0], row[1]) if row else None

    def fetch(self, simulation_id: UUID) -> list[dict[str, Any]]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    outbox.c.outbox_id,
                    outbox.c.sequence,
                    outbox.c.topic,
                    outbox.c.message_key,
                    outbox.c.message_value,
                    outbox.c.headers,
                )
                .where(outbox.c.simulation_id == simulation_id, outbox.c.published_at.is_(None))
                .order_by(outbox.c.sequence)
                .limit(self.settings.relay_batch_size)
            ).mappings()
            return [dict(r) for r in rows]

    def publish(self, rows: list[dict[str, Any]]) -> list[tuple[int, int] | str]:
        """Produce rows in order; returns per row (partition, offset) or an error string."""
        results: list[tuple[int, int] | str | None] = [None] * len(rows)

        def on_delivery(index: int) -> Any:
            def callback(err: KafkaError | None, msg: Message) -> None:
                if err is not None:
                    results[index] = f"{err.name()}: {err.str()}"
                else:
                    partition, offset = msg.partition(), msg.offset()
                    results[index] = (
                        (partition, offset)
                        if partition is not None and offset is not None
                        else "UNKNOWN: no partition/offset in delivery report"
                    )

            return callback

        for i, row in enumerate(rows):
            headers: list[tuple[str, str | bytes | None]] = [
                (str(k), str(v).encode()) for k, v in sorted(row["headers"].items())
            ]
            headers.append(("outbox_id", str(row["outbox_id"]).encode()))
            try:
                self.producer.produce(
                    row["topic"],
                    key=row["message_key"].encode(),
                    value=bytes(row["message_value"]),
                    headers=headers,
                    on_delivery=on_delivery(i),
                )
            except BufferError as exc:
                results[i] = f"LOCAL_QUEUE_FULL: {exc}"
                break
            except Exception as exc:  # e.g. KafkaException for an unknown topic
                results[i] = f"{type(exc).__name__}: {exc}"
                break
            self.producer.poll(0)
        remaining = self.producer.flush(self.settings.kafka_delivery_timeout_ms / 1000 + 5)
        if remaining:
            log.warning("flush timed out", extra={"undelivered": remaining})
        return [r if r is not None else "NOT_DELIVERED: no delivery report" for r in results]

    def mark(
        self,
        simulation_id: UUID,
        rows: list[dict[str, Any]],
        results: list[tuple[int, int] | str],
        failures_before: int,
    ) -> CycleResult:
        """Persist delivery outcomes and release the lease, in one short transaction."""
        prefix = 0
        while prefix < len(results) and isinstance(results[prefix], tuple):
            prefix += 1
        error = next((r for r in results[prefix:] if isinstance(r, str)), None)
        now = datetime.now(UTC)
        with self.engine.begin() as conn:
            if prefix:
                conn.execute(
                    update(outbox)
                    .where(outbox.c.outbox_id == bindparam("b_id"))
                    .values(
                        published_at=now,
                        kafka_partition=bindparam("b_partition"),
                        kafka_offset=bindparam("b_offset"),
                        attempts=outbox.c.attempts + 1,
                        last_attempt_at=now,
                        last_error=None,
                    ),
                    [
                        {"b_id": row["outbox_id"], "b_partition": res[0], "b_offset": res[1]}
                        for row, res in zip(rows[:prefix], results[:prefix], strict=True)
                        if isinstance(res, tuple)
                    ],
                )
            if error is not None:
                conn.execute(
                    update(outbox)
                    .where(outbox.c.outbox_id.in_([r["outbox_id"] for r in rows[prefix:]]))
                    .values(attempts=outbox.c.attempts + 1, last_attempt_at=now, last_error=error)
                )
                failures = failures_before + 1
                delay = backoff_s(
                    failures, self.settings.relay_backoff_base_s, self.settings.relay_backoff_max_s
                )
                run_values: dict[str, Any] = {
                    "relay_failures": failures,
                    "relay_last_error": error,
                    "relay_next_attempt_at": now + timedelta(seconds=delay),
                }
            else:
                run_values = {
                    "relay_failures": 0,
                    "relay_last_error": None,
                    "relay_next_attempt_at": None,
                }
            conn.execute(
                update(simulation_runs)
                .where(
                    simulation_runs.c.simulation_id == simulation_id,
                    simulation_runs.c.relay_owner == self.owner,
                )
                .values(relay_owner=None, relay_lease_until=None, **run_values)
            )
        return CycleResult(simulation_id, len(rows), prefix, error)

    def run_once(self) -> CycleResult:
        claimed = self.claim()
        if claimed is None:
            return CycleResult()
        simulation_id, failures = claimed
        rows = self.fetch(simulation_id)
        if not rows:
            self.mark(simulation_id, [], [], failures)
            return CycleResult(simulation_id)
        results = self.publish(rows)
        outcome = self.mark(simulation_id, rows, results, failures)
        self.stats.published_total += outcome.published
        if outcome.error:
            self.stats.failed_cycles += 1
            self.stats.last_error = outcome.error
            log.warning(
                "publish failed",
                extra={
                    "simulation_id": str(simulation_id),
                    "published": outcome.published,
                    "attempted": outcome.attempted,
                    "error": outcome.error,
                },
            )
        else:
            self.stats.last_published_at = datetime.now(UTC).isoformat()
            log.info(
                "published",
                extra={"simulation_id": str(simulation_id), "count": outcome.published},
            )
        return outcome

    # Loop ----------------------------------------------------------------------------------

    def run_forever(self) -> None:
        log.info("relay started", extra={"owner": self.owner})
        while not self.stop_event.is_set():
            try:
                outcome = self.run_once()
                self._beat()
            except Exception as exc:  # database unavailable etc.: back off, keep the process
                self.stats.last_error = f"{type(exc).__name__}: {exc}"
                log.exception("relay cycle failed")
                self._beat(degraded=True)
                self.stop_event.wait(self.settings.relay_backoff_base_s)
                continue
            if outcome.simulation_id is None or outcome.error:
                self.stop_event.wait(self.settings.relay_idle_sleep_s)
        self.release()
        self._beat(stopping=True)
        log.info("relay stopped", extra={"published_total": self.stats.published_total})

    def release(self) -> None:
        """Give up any lease this relay holds (graceful shutdown)."""
        try:
            with self.engine.begin() as conn:
                conn.execute(
                    update(simulation_runs)
                    .where(simulation_runs.c.relay_owner == self.owner)
                    .values(relay_owner=None, relay_lease_until=None)
                )
        except Exception:
            log.exception("could not release leases")

    def _beat(self, degraded: bool = False, stopping: bool = False) -> None:
        if not (degraded or stopping or self.heartbeat.due()):
            return
        try:
            details = {
                "published_total": self.stats.published_total,
                "failed_cycles": self.stats.failed_cycles,
                "last_error": self.stats.last_error,
                "last_published_at": self.stats.last_published_at,
            }
            if stopping:
                self.heartbeat.beat("stopping", details, force=True)
                return
            kafka_ok = degraded or broker_reachable(self.settings, timeout_s=3)
            ok = not degraded and kafka_ok
            if not kafka_ok:
                details["kafka"] = "unreachable"
            self.heartbeat.beat("ok" if ok else "degraded", details, force=degraded)
        except Exception:
            log.exception("heartbeat failed")

    def install_signal_handlers(self) -> None:
        def stop(signum: int, _frame: object) -> None:
            log.info("signal received, stopping", extra={"signal": signum})
            self.stop_event.set()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)


def wait_until_published(engine: Engine, simulation_id: UUID, timeout_s: float) -> bool:
    """Test/smoke helper: block until a run has no unpublished outbox rows."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        with engine.connect() as conn:
            pending = conn.execute(
                select(outbox.c.outbox_id)
                .where(outbox.c.simulation_id == simulation_id, outbox.c.published_at.is_(None))
                .limit(1)
            ).first()
        if pending is None:
            return True
        time.sleep(0.2)
    return False
