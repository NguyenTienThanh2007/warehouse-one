"""Ingestion boundary against a real PostgreSQL: atomicity, idempotency, ordering and validation.

Run with: uv run pytest -m integration (WAREHOUSE_DATABASE_URL must point at a disposable database;
these tests truncate the operations and pipeline tables).
"""

import copy
import threading
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select, text
from sqlalchemy.exc import DBAPIError

from tests.integration.conftest import RunFixture
from warehouse_api.ingest import service
from warehouse_api.ingest.service import BatchRequest, ingest_batch
from warehouse_api.store.tables import (
    command_log,
    domain_events,
    ingest_batches,
    outbox,
    simulation_runs,
)

pytestmark = pytest.mark.integration

TOPIC = "warehouse.domain-events.v1"


def register(client: TestClient, run: RunFixture) -> Any:
    return client.put(
        f"/api/v1/simulations/{run.simulation_id}",
        json={"config": run.config, "engine_version": "0.1.0", "source": "test"},
    )


def post(
    client: TestClient, run: RunFixture, batch: dict[str, Any], batch_id: str | None = None
) -> Any:
    body = {"batch_id": batch_id or str(uuid.uuid4()), **batch}
    return client.post(f"/api/v1/simulations/{run.simulation_id}/batches", json=body)


def of(run: RunFixture, events: list[dict[str, Any]]) -> dict[str, Any]:
    """A batch carrying `events`, closed at the tick of its last event."""
    return {"through_tick": run.tick_of(events[-1]), "commands": [], "events": events}


def counts(engine: Engine) -> dict[str, int]:
    with engine.connect() as conn:
        return {
            t.name: conn.execute(select(func.count()).select_from(t)).scalar_one()
            for t in (domain_events, outbox, command_log, ingest_batches)
        }


def error_code(response: Any) -> str:
    return str(response.json()["error"]["code"])


# Registration -----------------------------------------------------------------------------------


def test_register_is_idempotent_and_rejects_conflicts(
    client: TestClient, ops_demo: RunFixture
) -> None:
    assert register(client, ops_demo).status_code == 201
    again = register(client, ops_demo)
    assert again.status_code == 200 and again.json()["created"] is False
    changed = copy.deepcopy(ops_demo.config) | {"seed": "another-seed"}
    conflict = client.put(
        f"/api/v1/simulations/{ops_demo.simulation_id}",
        json={"config": changed, "engine_version": "0.1.0", "source": "test"},
    )
    assert conflict.status_code == 409 and error_code(conflict) == "RUN_CONFLICT"
    other = client.put(
        f"/api/v1/simulations/{uuid.uuid4()}",
        json={"config": ops_demo.config, "engine_version": "0.1.0", "source": "test"},
    )
    assert other.status_code == 422 and error_code(other) == "SIMULATION_MISMATCH"


def test_batches_require_a_registered_run(client: TestClient, ops_demo: RunFixture) -> None:
    response = post(client, ops_demo, ops_demo.batches(50)[0])
    assert response.status_code == 404 and error_code(response) == "UNKNOWN_SIMULATION"


# Full run ---------------------------------------------------------------------------------------


def test_full_run_is_stored_exactly_and_exported_in_order(
    client: TestClient, engine: Engine, ops_demo: RunFixture
) -> None:
    register(client, ops_demo)
    for batch in ops_demo.batches(40):
        response = post(client, ops_demo, batch)
        assert response.status_code == 201, response.text
    assert counts(engine) == {
        "domain_events": len(ops_demo.events),
        "outbox": len(ops_demo.events),
        "command_log": len(ops_demo.commands),
        "ingest_batches": len(ops_demo.batches(40)),
    }
    status = client.get(f"/api/v1/simulations/{ops_demo.simulation_id}").json()
    assert status["last_sequence"] == len(ops_demo.events)
    assert status["outbox"] == {"pending": len(ops_demo.events), "published": 0, "failing": 0}

    exported: list[dict[str, Any]] = []
    after = 0
    while True:
        page = client.get(
            f"/api/v1/simulations/{ops_demo.simulation_id}/events",
            params={"after_sequence": after, "limit": 64},
        ).json()
        exported += page["events"]
        if page["next_after_sequence"] is None:
            break
        after = page["next_after_sequence"]
    assert exported == ops_demo.events
    commands = client.get(f"/api/v1/simulations/{ops_demo.simulation_id}/commands").json()
    assert commands["commands"] == ops_demo.commands

    # The outbox carries exactly the canonical envelope, keyed by run, with routing headers.
    with engine.connect() as conn:
        row = conn.execute(select(outbox).order_by(outbox.c.sequence).limit(1)).mappings().one()
    assert row["message_key"] == ops_demo.simulation_id and row["topic"] == TOPIC
    assert row["headers"]["event_type"] == ops_demo.events[0]["event_type"]
    assert service.canonical_json(ops_demo.events[0]) == bytes(row["message_value"])


# Idempotency and duplicates ---------------------------------------------------------------------


def test_retried_batch_returns_the_original_result_and_stores_nothing_new(
    client: TestClient, engine: Engine, ops_demo: RunFixture
) -> None:
    register(client, ops_demo)
    batch = ops_demo.batches(40)[0]
    first = post(client, ops_demo, batch, batch_id="00000000-0000-4000-8000-000000000001")
    before = counts(engine)
    retry = post(client, ops_demo, batch, batch_id="00000000-0000-4000-8000-000000000001")
    assert first.status_code == 201 and retry.status_code == 200
    assert retry.json()["replayed"] is True
    assert retry.json()["accepted_events"] == first.json()["accepted_events"]
    assert counts(engine) == before

    reused = post(
        client, ops_demo, ops_demo.batches(40)[1], batch_id="00000000-0000-4000-8000-000000000001"
    )
    assert reused.status_code == 409 and error_code(reused) == "BATCH_ID_REUSED"


def test_identical_overlap_is_a_duplicate_and_only_the_tail_is_new(
    client: TestClient, engine: Engine, ops_demo: RunFixture
) -> None:
    register(client, ops_demo)
    post(client, ops_demo, of(ops_demo, ops_demo.events[:30]))
    overlap = post(client, ops_demo, of(ops_demo, ops_demo.events[10:50]))
    assert overlap.status_code == 201, overlap.text
    assert overlap.json()["duplicate_events"] == 20 and overlap.json()["accepted_events"] == 20
    assert counts(engine)["domain_events"] == 50


def test_conflicting_duplicate_is_rejected_and_nothing_is_written(
    client: TestClient, engine: Engine, ops_demo: RunFixture
) -> None:
    register(client, ops_demo)
    post(client, ops_demo, of(ops_demo, ops_demo.events[:10]))
    before = counts(engine)
    forged = copy.deepcopy(ops_demo.events[:12])
    forged[5]["correlation_id"] = "someone-else"
    response = post(client, ops_demo, of(ops_demo, forged))
    assert response.status_code == 409 and error_code(response) == "CONFLICTING_EVENT"
    assert response.json()["error"]["details"]["sequence"] == 6
    assert counts(engine) == before


# Ordering and continuity -----------------------------------------------------------------------


def test_sequence_gap_is_rejected(client: TestClient, ops_demo: RunFixture) -> None:
    register(client, ops_demo)
    post(client, ops_demo, of(ops_demo, ops_demo.events[:10]))
    response = post(client, ops_demo, of(ops_demo, ops_demo.events[11:20]))
    assert response.status_code == 409 and error_code(response) == "SEQUENCE_GAP"
    assert response.json()["error"]["details"] == {"expected_sequence": 11, "got": 12}


def test_non_contiguous_batch_is_rejected(client: TestClient, ops_demo: RunFixture) -> None:
    register(client, ops_demo)
    events = ops_demo.events[:3] + ops_demo.events[4:6]
    response = post(client, ops_demo, of(ops_demo, events))
    assert response.status_code == 422 and error_code(response) == "NON_CONTIGUOUS_BATCH"


@pytest.mark.parametrize(
    ("delta", "code"), [(1, "AGGREGATE_VERSION_GAP"), (-1, "AGGREGATE_VERSION_REGRESSION")]
)
def test_aggregate_version_must_continue_by_one(
    client: TestClient, ops_demo: RunFixture, delta: int, code: str
) -> None:
    register(client, ops_demo)
    # Find an event whose aggregate already has history earlier in the run.
    seen: dict[tuple[str, str], int] = {}
    index = next(
        i
        for i, e in enumerate(ops_demo.events)
        if seen.setdefault((e["aggregate_type"], e["aggregate_id"]), i) != i
    )
    events = copy.deepcopy(ops_demo.events[: index + 1])
    events[index]["aggregate_version"] += delta
    tick = ops_demo.tick_of(events[-1])
    response = post(client, ops_demo, {"through_tick": tick, "commands": [], "events": events})
    assert response.status_code == 409 and error_code(response) == code


# Contract validation ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda e: e.update(event_id=str(uuid.uuid4())), "EVENT_ID_MISMATCH"),
        (lambda e: e.update(occurred_at="2030-01-01T00:00:00.000Z"), "INVALID_OCCURRED_AT"),
        (
            lambda e: e.update(simulation_time_ms=e["simulation_time_ms"] + 1),
            "INVALID_SIMULATION_TIME",
        ),
        (lambda e: e["payload"].update(unexpected=True), "INVALID_EVENT"),
        (lambda e: e.update(sequence="1"), "INVALID_EVENT"),
        (lambda e: e.update(event_type="inventory.teleported"), "INVALID_EVENT"),
        (lambda e: e.update(simulation_id=str(uuid.uuid4())), "SIMULATION_MISMATCH"),
    ],
)
def test_contract_violations_are_rejected(
    client: TestClient, engine: Engine, ops_demo: RunFixture, mutate: Any, code: str
) -> None:
    register(client, ops_demo)
    event = copy.deepcopy(ops_demo.events[0])
    mutate(event)
    response = post(client, ops_demo, {"through_tick": 1, "commands": [], "events": [event]})
    assert response.status_code == 422, response.text
    assert error_code(response) == code
    assert counts(engine)["domain_events"] == 0


def test_commands_are_validated_and_closed_ticks_are_protected(
    client: TestClient, ops_demo: RunFixture
) -> None:
    register(client, ops_demo)
    bad = {
        "tick": 1,
        "command": {"command_id": "x", "type": "order.create", "payload": {"lines": []}},
    }
    response = post(client, ops_demo, {"through_tick": 1, "commands": [bad], "events": []})
    assert response.status_code == 422 and error_code(response) == "INVALID_COMMAND"

    post(client, ops_demo, {"through_tick": 5, "commands": [], "events": []})
    late = {
        "tick": 3,
        "command": {"command_id": "late", "type": "order.cancel", "payload": {"order_id": "ord-1"}},
    }
    response = post(client, ops_demo, {"through_tick": 5, "commands": [late], "events": []})
    assert response.status_code == 409 and error_code(response) == "COMMAND_TICK_CLOSED"


def test_request_size_limits(client: TestClient, ops_demo: RunFixture) -> None:
    register(client, ops_demo)
    too_many = {"through_tick": 1, "commands": [], "events": [{}] * 1001}
    assert post(client, ops_demo, too_many).status_code == 422
    huge = client.post(
        f"/api/v1/simulations/{ops_demo.simulation_id}/batches",
        content=b"{" + b" " * (5 * 1024 * 1024) + b"}",
        headers={"content-type": "application/json"},
    )
    assert huge.status_code == 413 and error_code(huge) == "BODY_TOO_LARGE"


# Atomicity and durability -----------------------------------------------------------------------


def test_a_failure_mid_transaction_leaves_no_partial_records(
    engine: Engine, client: TestClient, ops_demo: RunFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    register(client, ops_demo)

    def broken_outbox(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("simulated failure after events were inserted")

    monkeypatch.setattr(service, "insert_outbox", broken_outbox)
    req = BatchRequest(
        simulation_id=uuid.UUID(ops_demo.simulation_id),
        batch_id=uuid.uuid4(),
        through_tick=ops_demo.tick_of(ops_demo.events[19]),
        commands=[
            c for c in ops_demo.commands if c["tick"] <= ops_demo.tick_of(ops_demo.events[19])
        ],
        events=ops_demo.events[:20],
    )
    with pytest.raises(RuntimeError), engine.begin() as conn:
        ingest_batch(conn, req, TOPIC)
    assert counts(engine) == {
        "domain_events": 0,
        "outbox": 0,
        "command_log": 0,
        "ingest_batches": 0,
    }
    with engine.connect() as conn:
        run = conn.execute(select(simulation_runs)).mappings().one()
    assert (run["last_sequence"], run["event_count"], run["through_tick"]) == (0, 0, 0)


def test_events_and_commands_are_append_only(
    client: TestClient, engine: Engine, ops_demo: RunFixture
) -> None:
    register(client, ops_demo)
    post(client, ops_demo, ops_demo.batches(40)[0])
    for statement in (
        "UPDATE operations.domain_events SET correlation_id = 'x'",
        "DELETE FROM operations.domain_events",
        "UPDATE operations.command_log SET tick = tick + 1",
        "DELETE FROM operations.command_log",
    ):
        with pytest.raises(DBAPIError, match="append-only"), engine.begin() as conn:
            conn.execute(text(statement))


def test_concurrent_retries_of_one_batch_store_it_once(
    engine: Engine, client: TestClient, ops_demo: RunFixture
) -> None:
    register(client, ops_demo)
    batch = ops_demo.batches(40)[0]
    batch_id = str(uuid.uuid4())
    statuses: list[int] = []

    def send() -> None:
        statuses.append(post(client, ops_demo, batch, batch_id=batch_id).status_code)

    threads = [threading.Thread(target=send) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(statuses) == [200, 200, 200, 201]
    assert counts(engine)["domain_events"] == len(batch["events"])
