"""Outbox relay against real PostgreSQL and Kafka (DEC-025, DEC-026).

Run with: uv run pytest -m kafka
(needs WAREHOUSE_DATABASE_URL and WAREHOUSE_KAFKA_BOOTSTRAP_SERVERS).
"""

import json
import threading
import time
from collections import Counter, defaultdict
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine, func, select, update

from tests.integration.conftest import RunFixture
from tests.integration.kafka_support import drain, isolated_settings, store_run
from warehouse_api.store.tables import outbox, simulation_runs
from warehouse_pipeline.kafka import ensure_topics
from warehouse_pipeline.relay import OutboxRelay, backoff_s, wait_until_published

pytestmark = [pytest.mark.integration, pytest.mark.kafka]


@pytest.fixture(scope="session")
def foundation() -> RunFixture:
    return RunFixture("foundation-demo")


def unpublished(engine: Engine) -> int:
    with engine.connect() as conn:
        return int(
            conn.execute(
                select(func.count()).select_from(outbox).where(outbox.c.published_at.is_(None))
            ).scalar_one()
        )


def relay_until_idle(relay: OutboxRelay, limit: int = 200) -> None:
    for _ in range(limit):
        if relay.run_once().simulation_id is None:
            return
    raise AssertionError("relay did not become idle")


def test_backoff_is_exponential_and_bounded() -> None:
    assert [backoff_s(n, 1.0, 60.0) for n in (1, 2, 3, 4, 7, 50)] == [1, 2, 4, 8, 60, 60]


def test_publishes_a_run_in_sequence_order_keyed_by_run(
    engine: Engine, ops_demo: RunFixture
) -> None:
    settings = isolated_settings()
    ensure_topics(settings)
    sim = store_run(engine, ops_demo, settings.kafka_events_topic)
    relay = OutboxRelay(engine, settings, owner="relay-a")
    relay_until_idle(relay)
    assert unpublished(engine) == 0

    messages = drain(settings, settings.kafka_events_topic, len(ops_demo.events))
    assert len(messages) == len(ops_demo.events)
    # One run → one key → one partition; offsets follow sequence order.
    assert {m.key for m in messages} == {str(sim).encode()}
    assert len({m.partition for m in messages}) == 1
    ordered = sorted(messages, key=lambda m: m.offset)
    assert [json.loads(m.value)["sequence"] for m in ordered] == list(
        range(1, len(ops_demo.events) + 1)
    )
    assert [json.loads(m.value) for m in ordered] == ops_demo.events
    first = ordered[0].headers
    assert first["event_id"].decode() == ops_demo.events[0]["event_id"]
    assert first["event_type"].decode() == ops_demo.events[0]["event_type"]

    with engine.connect() as conn:
        rows = conn.execute(select(outbox).order_by(outbox.c.sequence)).mappings().all()
    assert all(r["published_at"] is not None and r["attempts"] == 1 for r in rows)
    assert [r["kafka_offset"] for r in rows] == [m.offset for m in ordered]


def test_broker_outage_keeps_events_durable_and_recovers(
    engine: Engine, ops_demo: RunFixture
) -> None:
    good = isolated_settings()
    ensure_topics(good)
    sim = store_run(engine, ops_demo, good.kafka_events_topic)
    down = good.model_copy(update={"kafka_bootstrap_servers": "127.0.0.1:1"})
    outage = OutboxRelay(engine, down, owner="relay-down").run_once()
    assert outage.published == 0 and outage.error is not None
    assert unpublished(engine) == len(ops_demo.events)
    with engine.connect() as conn:
        run = conn.execute(select(simulation_runs)).mappings().one()
        attempts = conn.execute(select(func.max(outbox.c.attempts))).scalar_one()
    assert run["relay_failures"] == 1 and run["relay_last_error"]
    assert run["relay_next_attempt_at"] is not None and run["relay_owner"] is None
    assert attempts == 1

    # Within the backoff window nobody retries; afterwards a healthy relay publishes everything.
    relay = OutboxRelay(engine, good, owner="relay-up")
    assert relay.run_once().simulation_id is None
    time.sleep(0.3)
    relay_until_idle(relay)
    assert unpublished(engine) == 0
    assert len(drain(good, good.kafka_events_topic, len(ops_demo.events))) == len(ops_demo.events)
    with engine.connect() as conn:
        run = (
            conn.execute(select(simulation_runs).where(simulation_runs.c.simulation_id == sim))
            .mappings()
            .one()
        )
    assert run["relay_failures"] == 0 and run["relay_last_error"] is None


def test_crash_after_ack_before_commit_redelivers(
    engine: Engine, ops_demo: RunFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = isolated_settings(relay_batch_size=40)
    ensure_topics(settings)
    store_run(engine, ops_demo, settings.kafka_events_topic)
    crashing = OutboxRelay(engine, settings, owner="relay-crash")

    def crash(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("process killed after the broker acknowledged")

    monkeypatch.setattr(crashing, "mark", crash)
    with pytest.raises(RuntimeError):
        crashing.run_once()
    assert unpublished(engine) == len(ops_demo.events)  # nothing marked
    # The crashed relay's lease expires; another relay takes over and republishes.
    with engine.begin() as conn:
        conn.execute(update(simulation_runs).values(relay_lease_until=func.now()))
    relay_until_idle(OutboxRelay(engine, settings, owner="relay-b"))
    assert unpublished(engine) == 0
    messages = drain(settings, settings.kafka_events_topic, len(ops_demo.events) + 40)
    ids = Counter(m.headers["event_id"].decode() for m in messages)
    assert len(ids) == len(ops_demo.events)  # every event delivered
    assert sorted(ids.values()).count(2) == 40  # the first batch twice: at-least-once


def test_concurrent_relays_publish_every_event_once_and_in_order(
    engine: Engine, ops_demo: RunFixture, foundation: RunFixture
) -> None:
    settings = isolated_settings(relay_batch_size=25)
    ensure_topics(settings)
    store_run(engine, ops_demo, settings.kafka_events_topic)
    store_run(engine, foundation, settings.kafka_events_topic)
    total = len(ops_demo.events) + len(foundation.events)

    relays = [OutboxRelay(engine, settings, owner=f"relay-{i}") for i in range(3)]
    threads = [threading.Thread(target=r.run_forever) for r in relays]
    for t in threads:
        t.start()
    try:
        for sim in (ops_demo.simulation_id, foundation.simulation_id):
            assert wait_until_published(engine, UUID(sim), timeout_s=60)
    finally:
        for r in relays:
            r.stop_event.set()
        for t in threads:
            t.join(timeout=30)
    messages = drain(settings, settings.kafka_events_topic, total)
    assert len(messages) == total
    assert len({m.headers["event_id"] for m in messages}) == total  # no duplicates
    per_run: dict[bytes | None, list[tuple[int, int]]] = defaultdict(list)
    for m in messages:
        per_run[m.key].append((m.offset, json.loads(m.value)["sequence"]))
    for seqs in per_run.values():
        assert [s for _, s in sorted(seqs)] == sorted(s for _, s in seqs)
    assert sum(r.stats.published_total for r in relays) == total
    with engine.connect() as conn:  # graceful shutdown released every lease
        owners = conn.execute(select(simulation_runs.c.relay_owner)).scalars().all()
    assert owners == [None, None]


def test_a_live_lease_is_respected_and_an_expired_one_taken_over(
    engine: Engine, ops_demo: RunFixture
) -> None:
    settings = isolated_settings(relay_lease_s=60)
    ensure_topics(settings)
    store_run(engine, ops_demo, settings.kafka_events_topic)
    holder = OutboxRelay(engine, settings, owner="holder")
    assert holder.claim() is not None  # holds the lease and "hangs"
    other = OutboxRelay(engine, settings, owner="other")
    assert other.claim() is None
    with engine.begin() as conn:
        conn.execute(update(simulation_runs).values(relay_lease_until=func.now()))
    assert other.claim() is not None
