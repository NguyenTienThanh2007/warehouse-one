"""Proposal lifecycle against a real PostgreSQL: validation, approval, execution, audit, AI."""

import threading
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from tests import twin_support as ts
from tests.conftest import make_client
from tests.test_twin_ai import FakeProvider, good_answer
from warehouse_api.api.twin import get_provider
from warehouse_api.config import Settings
from warehouse_api.twin import ai

pytestmark = pytest.mark.integration

URL = "/api/v1/twin/proposals"


def create(client: TestClient, evaluation: dict[str, Any] | None = None) -> dict[str, Any]:
    response = client.post(URL, json=ts.body(evaluation))
    assert response.status_code in (200, 201), response.text
    data: dict[str, Any] = response.json()
    return data


def decide(client: TestClient, pid: str, decision: str, **over: Any) -> Any:
    payload = {"decision": decision, "actor": "Alex (shift lead)", "context": ts.live(), **over}
    return client.post(f"{URL}/{pid}/decision", json=payload)


def history(client: TestClient, pid: str) -> list[tuple[str, str | None, str]]:
    return [
        (h["action"], h["from_status"], h["to_status"])
        for h in client.get(f"{URL}/{pid}").json()["history"]
    ]


def test_create_validates_on_the_server_and_is_idempotent(client: TestClient) -> None:
    first = client.post(URL, json=ts.body())
    assert first.status_code == 201, first.text
    p = first.json()
    assert p["status"] == "validated"
    assert p["version"] == 1
    assert all(c["passed"] for c in p["validation"])
    assert p["commands"] and all(c["type"] == "linehaul.set_standby" for c in p["commands"])
    assert p["objective"]["metric"] == "pickup_wait_s"
    assert p["objective"]["pct"] < 0
    assert history(client, p["proposal_id"]) == [
        ("created", None, "generated"),
        ("validation", "generated", "validated"),
    ]
    again = client.post(URL, json=ts.body())
    assert again.status_code == 200
    assert again.json()["proposal_id"] == p["proposal_id"]
    assert len(client.get(URL).json()["items"]) == 1


def test_nothing_to_recommend_and_invalid_evaluations_are_kept_for_the_record(
    client: TestClient,
) -> None:
    none = create(client, ts.unchanged())
    assert none["status"] == "not_actionable"
    assert none["commands"] == []
    bad = ts.with_new_id(ts.recommended(), "ab")
    ts.chosen(bad)["metrics"]["pickup_wait_s"] = 999.0
    invalid = create(client, bad)
    assert invalid["status"] == "invalid"
    assert [c["id"] for c in invalid["validation"] if not c["passed"]] == ["objective_improves"]
    assert invalid["commands"] == []
    for pid in (none["proposal_id"], invalid["proposal_id"]):
        r = decide(client, pid, "approve")
        assert r.status_code == 409
        assert r.json()["error"]["code"] == "INVALID_TRANSITION"


def test_malformed_input_is_rejected_before_storage(client: TestClient) -> None:
    body = ts.body()
    body["evaluation"]["candidates"][0]["metrics"]["empty_km"] = -1
    assert client.post(URL, json=body).status_code == 422
    body = ts.body()
    body["evaluation"]["sneaky"] = True
    assert client.post(URL, json=body).status_code == 422
    assert client.get(URL).json()["items"] == []


def test_approval_flow_with_idempotency_and_audit(client: TestClient) -> None:
    pid = create(client)["proposal_id"]
    no_context = client.post(f"{URL}/{pid}/decision", json={"decision": "approve", "actor": "Alex"})
    assert no_context.status_code == 422
    assert no_context.json()["error"]["code"] == "CONTEXT_REQUIRED"

    ok = decide(client, pid, "approve", note="Terminal is busy today")
    assert ok.status_code == 200, ok.text
    p = ok.json()
    assert p["status"] == "approved"
    assert p["decided_by"] == "Alex (shift lead)"
    assert p["decision_note"] == "Terminal is busy today"
    repeat = decide(client, pid, "approve")
    assert repeat.status_code == 200
    assert repeat.json()["version"] == p["version"]
    assert [h for h in history(client, pid) if h[0] == "approve"] == [
        ("approve", "validated", "approved")
    ]
    stale_version = decide(client, pid, "reject", expected_version=1)
    assert stale_version.status_code == 409
    assert stale_version.json()["error"]["code"] == "VERSION_CONFLICT"


def test_rejected_proposals_cannot_be_approved_or_executed(client: TestClient) -> None:
    pid = create(client)["proposal_id"]
    assert decide(client, pid, "reject").json()["status"] == "rejected"
    assert decide(client, pid, "reject").status_code == 200  # repeat: idempotent
    assert decide(client, pid, "approve").status_code == 409
    r = client.post(f"{URL}/{pid}/execution", json={"actor": "Alex", "context": ts.live()})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "NOT_APPROVED"


@pytest.mark.parametrize(
    ("context", "reason"),
    [
        (ts.live(fleet_fingerprint="ab" * 16), "fleet_changed"),
        (ts.live(ticks_later=18_001), "too_old"),
        (ts.live(ticks_later=-5), "run_restarted"),
        (ts.live(config_hash="cd" * 16), "other_run"),
    ],
)
def test_stale_proposals_expire_instead_of_being_approved(
    client: TestClient, context: dict[str, Any], reason: str
) -> None:
    pid = create(client)["proposal_id"]
    r = decide(client, pid, "approve", context=context)
    assert r.status_code == 409
    assert r.json()["error"] == {
        "code": "STALE_PROPOSAL",
        "message": r.json()["error"]["message"],
        "details": {"reason": reason},
    }
    p = client.get(f"{URL}/{pid}").json()
    assert p["status"] == "expired"
    assert history(client, pid)[-1] == ("expired", "validated", "expired")


def test_execution_is_claimed_once_and_reported_honestly(client: TestClient) -> None:
    pid = create(client)["proposal_id"]
    early = client.post(f"{URL}/{pid}/execution", json={"actor": "Alex", "context": ts.live()})
    assert early.json()["error"]["code"] == "NOT_APPROVED"  # never without approval
    decide(client, pid, "approve")
    claim = client.post(f"{URL}/{pid}/execution", json={"actor": "Alex", "context": ts.live()})
    assert claim.status_code == 200, claim.text
    commands = claim.json()["commands"]
    assert claim.json()["proposal"]["status"] == "executing"
    twice = client.post(f"{URL}/{pid}/execution", json={"actor": "Alex", "context": ts.live()})
    assert twice.status_code == 409
    assert twice.json()["error"]["code"] == "ALREADY_EXECUTED"

    partial = [{"command_id": c["command_id"], "accepted": True} for c in commands[:-1]]
    lie = client.post(
        f"{URL}/{pid}/execution/result",
        json={"actor": "Alex", "outcome": "applied", "results": partial},
    )
    assert lie.status_code == 422
    assert lie.json()["error"]["code"] == "INCONSISTENT_RESULT"

    results = [{"command_id": c["command_id"], "accepted": True} for c in commands]
    done = client.post(
        f"{URL}/{pid}/execution/result",
        json={"actor": "Alex", "outcome": "applied", "applied_tick": 6_200, "results": results},
    )
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "applied"
    assert done.json()["executed_tick"] == 6_200
    assert [h[0] for h in history(client, pid)] == [
        "created",
        "validation",
        "approve",
        "execute",
        "applied",
    ]


def test_a_refused_command_is_recorded_as_failed(client: TestClient) -> None:
    pid = create(client)["proposal_id"]
    decide(client, pid, "approve")
    commands = client.post(
        f"{URL}/{pid}/execution", json={"actor": "Alex", "context": ts.live()}
    ).json()["commands"]
    results = [{"command_id": c["command_id"], "accepted": True} for c in commands]
    results[0] = {**results[0], "accepted": False, "code": "INVALID_STANDBY", "message": "full"}
    r = client.post(
        f"{URL}/{pid}/execution/result",
        json={"actor": "Alex", "outcome": "failed", "results": results},
    )
    assert r.json()["status"] == "failed"


def test_a_newer_proposal_supersedes_one_awaiting_a_decision(client: TestClient) -> None:
    old = create(client)["proposal_id"]
    new = create(client, ts.with_new_id(ts.recommended(), "cd"))["proposal_id"]
    assert client.get(f"{URL}/{old}").json()["status"] == "superseded"
    assert client.get(f"{URL}/{new}").json()["status"] == "validated"
    assert decide(client, old, "approve").status_code == 409


def test_concurrent_approvals_record_one_decision(client: TestClient, engine: Engine) -> None:
    pid = create(client)["proposal_id"]
    codes: list[int] = []

    def approve() -> None:
        codes.append(decide(client, pid, "approve").status_code)

    threads = [threading.Thread(target=approve) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert codes == [200] * 6
    with engine.connect() as conn:
        approvals = conn.execute(
            text(
                "SELECT count(*) FROM twin.proposal_events "
                "WHERE proposal_id = :p AND action = 'approve'"
            ),
            {"p": pid},
        ).scalar_one()
    assert approvals == 1


def test_the_audit_trail_is_append_only(client: TestClient, engine: Engine) -> None:
    create(client)
    with pytest.raises(DBAPIError, match="append-only"), engine.begin() as conn:
        conn.execute(text("UPDATE twin.proposal_events SET actor = 'someone else'"))
    with pytest.raises(DBAPIError, match="append-only"), engine.begin() as conn:
        conn.execute(text("DELETE FROM twin.proposal_events"))


def test_list_is_bounded_and_paginated(client: TestClient) -> None:
    ids = [
        create(client, ts.with_new_id(ts.recommended(), f"{i:02x}"))["proposal_id"]
        for i in range(5)
    ]
    page = client.get(URL, params={"limit": 2}).json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    rest = client.get(URL, params={"limit": 50, "cursor": page["next_cursor"]}).json()
    seen = [p["proposal_id"] for p in page["items"] + rest["items"]]
    assert sorted(seen) == sorted(ids) and rest["next_cursor"] is None
    assert client.get(URL, params={"limit": 51}).status_code == 422
    assert client.get(URL, params={"cursor": "garbage"}).status_code == 422
    validated = client.get(URL, params={"status": "validated"}).json()["items"]
    assert [p["proposal_id"] for p in validated] == [ids[-1]]  # the others were superseded


def test_snapshot_is_stored_for_re_evaluation(client: TestClient) -> None:
    pid = create(client)["proposal_id"]
    snap = client.get(f"{URL}/{pid}/snapshot").json()
    assert snap == ts.snapshot()
    assert "input_snapshot" not in client.get(f"{URL}/{pid}").text
    assert client.get(f"{URL}/00000000-0000-4000-8000-000000000000").status_code == 404


# ---------------------------------------------------------------------------------------------
# AI explanations


@pytest.fixture
def ai_client(engine: Engine, settings: Settings) -> Iterator[tuple[TestClient, list[Any]]]:
    providers: list[Any] = []
    with make_client(settings, engine) as c:
        c.app.dependency_overrides[get_provider] = lambda: providers[-1]  # type: ignore[attr-defined]
        yield c, providers


def test_explanations_need_a_configured_provider(client: TestClient) -> None:
    pid = create(client)["proposal_id"]
    r = client.post(f"{URL}/{pid}/explanations")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "AI_NOT_CONFIGURED"
    assert client.get(f"{URL}/{pid}").json()["explanations"] == []


def test_explanations_are_stored_and_labelled(ai_client: tuple[TestClient, list[Any]]) -> None:
    client, providers = ai_client
    p = create(client)
    row = {"status": p["status"], "evaluation": p["evaluation"], "validation": p["validation"]}
    providers.append(FakeProvider(good_answer(row)))
    r = client.post(f"{URL}/{p['proposal_id']}/explanations")
    assert r.status_code == 201, r.text
    e = r.json()
    assert e["provenance"] == "ai_generated" and e["status"] == "ok"
    assert e["content"]["stance"] == "supports_approval"

    providers.append(FakeProvider(ai.AiError("AI_RATE_LIMITED", "slow down", 429, 30)))
    limited = client.post(f"{URL}/{p['proposal_id']}/explanations")
    assert limited.status_code == 429
    assert limited.json()["error"]["details"]["retry_after_s"] == 30
    stored = client.get(f"{URL}/{p['proposal_id']}").json()["explanations"]
    assert [x["status"] for x in stored] == ["ok", "failed"]
    assert stored[1]["error_code"] == "AI_RATE_LIMITED"
    # Explaining never changes the proposal.
    assert client.get(f"{URL}/{p['proposal_id']}").json()["status"] == "validated"


def test_explanations_per_proposal_are_capped(
    ai_client: tuple[TestClient, list[Any]], settings: Settings
) -> None:
    client, providers = ai_client
    p = create(client)
    providers.append(FakeProvider(ai.AiError("AI_TIMEOUT", "slow", 504)))
    for _ in range(settings.ai_max_explanations_per_proposal):
        assert client.post(f"{URL}/{p['proposal_id']}/explanations").status_code == 504
    capped = client.post(f"{URL}/{p['proposal_id']}/explanations")
    assert capped.status_code == 429
    assert capped.json()["error"]["code"] == "EXPLANATION_LIMIT"


def test_the_stored_evaluation_is_exactly_the_computed_one(client: TestClient) -> None:
    # Regression: the API re-serialised simulated time ("…:00Z" for "…:00.000Z"), so a stored
    # proposal no longer re-verified with `pnpm twin:verify`. Deltas are recomputed by the
    # server and must come out identical too.
    stored = create(client)["evaluation"]
    assert stored == ts.recommended()
