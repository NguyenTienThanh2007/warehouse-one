"""Server-side validation of proposals: independent of the browser's verdict."""

from typing import Any

import pytest

from tests import twin_support as ts
from warehouse_api.twin import rules
from warehouse_api.twin.schemas import Evaluation, InputSnapshot, LiveContext


def validate(evaluation: dict[str, Any], snapshot: dict[str, Any] | None = None) -> rules.Validated:
    return rules.validate(
        Evaluation.model_validate(evaluation),
        InputSnapshot.model_validate(snapshot or ts.snapshot()),
        prefix="t",
    )


def failed(v: rules.Validated) -> list[str]:
    return [c.id for c in v.checks if not c.passed]


def test_the_optimisers_recommendation_validates() -> None:
    v = validate(ts.recommended())
    assert v.status == "validated", v.checks
    assert [c.id for c in v.checks] == [
        "strategy_supported",
        "snapshot_matches_source",
        "baseline_is_plan_in_effect",
        "recommendation_consistent",
        "plan_rules",
        "objective_improves",
        "service_level",
        "commands_valid",
    ]


def test_server_deltas_equal_the_typescript_deltas() -> None:
    # Same arithmetic and rounding on both sides: the stored figures do not depend on who computed.
    e = ts.recommended()
    v = validate(e)
    for theirs, ours in zip(e["candidates"], v.evaluation.candidates, strict=True):
        assert [d.model_dump() for d in ours.deltas] == theirs["deltas"]


def test_commands_clear_trucks_before_placing_them() -> None:
    e = ts.recommended()
    v = validate(e)
    plan = {a["vehicle_id"]: a["site_id"] for a in ts.chosen(e)["plan"]["assignments"]}
    sets = [c for c in v.commands if c["payload"]["site_id"] is not None]
    assert {c["payload"]["vehicle_id"]: c["payload"]["site_id"] for c in sets} == {
        k: s for k, s in plan.items() if s is not None
    }
    assert all(c["type"] == "linehaul.set_standby" for c in v.commands)
    assert [c["command_id"] for c in v.commands] == [f"t-{i + 1}" for i in range(len(v.commands))]


def test_nothing_to_recommend_is_not_actionable() -> None:
    v = validate(ts.unchanged())
    assert v.status == "not_actionable"
    assert v.commands == []


def test_a_claimed_improvement_the_metrics_do_not_support_is_invalid() -> None:
    e = ts.recommended()
    ts.chosen(e)["metrics"]["pickup_wait_s"] = e["baseline"]["metrics"]["pickup_wait_s"] + 1
    v = validate(e)
    assert v.status == "invalid"
    assert failed(v) == ["objective_improves"]
    assert v.commands == []


def test_an_over_capacity_plan_is_invalid_whatever_the_browser_says() -> None:
    e = ts.recommended()
    terminal = "harbour-terminal"
    for a in ts.chosen(e)["plan"]["assignments"]:
        a["site_id"] = terminal  # 6 trucks, 3 allowed
    v = validate(e)
    assert v.status == "invalid"
    assert "plan_rules" in failed(v)
    check = next(c for c in v.checks if c.id == "plan_rules")
    assert "capacity 3" in check.detail


def test_standby_at_the_depot_or_gateway_is_invalid() -> None:
    e = ts.recommended()
    ts.chosen(e)["plan"]["assignments"][0]["site_id"] = "east-gateway"
    assert "plan_rules" in failed(validate(e))


def test_an_infeasible_candidate_cannot_be_the_recommendation() -> None:
    e = ts.recommended()
    ts.chosen(e)["constraints"][0]["satisfied"] = False
    assert failed(validate(e)) == ["recommendation_consistent"]


def test_service_floor_is_rechecked() -> None:
    e = ts.recommended()
    ts.chosen(e)["metrics"]["pallets_delivered"] = 0
    assert "service_level" in failed(validate(e))


def test_snapshot_must_be_the_evaluated_state() -> None:
    snap = ts.snapshot()
    snap["state_hash"] = "0" * 32
    v = validate(ts.recommended(), snap)
    assert v.status == "invalid"
    assert "snapshot_matches_source" in failed(v)


def test_baseline_must_be_the_plan_in_effect() -> None:
    e = ts.recommended()
    e["baseline"]["plan"]["assignments"][0]["site_id"] = "riverside-xd"
    assert "baseline_is_plan_in_effect" in failed(validate(e))


def test_unknown_strategy_version_is_invalid() -> None:
    e = ts.recommended()
    e["strategy"]["version"] = "9.9.9"
    assert "strategy_supported" in failed(validate(e))


@pytest.mark.parametrize(
    ("baseline", "candidate", "expected"),
    [
        (0, 5, {"abs": 5, "pct": None, "improved": False}),
        (None, 5, {"abs": None, "pct": None, "improved": None}),
        (80, 60, {"abs": -20, "pct": -25.0, "improved": True}),
        (3, 2, {"abs": -1, "pct": -33.3, "improved": True}),
    ],
)
def test_deltas_never_divide_by_zero(
    baseline: float | None, candidate: float, expected: dict[str, Any]
) -> None:
    d = rules.metric_delta("pickup_wait_s", baseline, candidate)
    assert {k: getattr(d, k) for k in expected} == expected
    assert d.unit == "s"


def test_rounding_matches_javascript() -> None:
    # Math.round rounds halves up; Python's round() would give 0.0 and -2.0 here.
    assert rules.js_round(0.05, 1) == 0.1
    assert rules.js_round(-2.5, 0) == -2.0
    assert rules.js_round(2.5, 0) == 3.0


def row(**over: Any) -> dict[str, Any]:
    src = ts.recommended()["source"]
    return {
        "simulation_id": src["simulation_id"],
        "config_hash": src["config_hash"],
        "source_tick": src["tick"],
        "fleet_fingerprint": src["fleet_fingerprint"],
        **over,
    }


@pytest.mark.parametrize(
    ("live", "reason"),
    [
        (ts.live(ticks_later=0), None),
        (ts.live(ticks_later=18_000), None),
        (ts.live(ticks_later=18_001), "too_old"),
        (ts.live(ticks_later=-1), "run_restarted"),
        (ts.live(fleet_fingerprint="ab" * 16), "fleet_changed"),
        (ts.live(config_hash="cd" * 16), "other_run"),
        (ts.live(simulation_id="00000000-0000-4000-8000-000000000000"), "other_run"),
    ],
)
def test_staleness(live: dict[str, Any], reason: str | None) -> None:
    stale = rules.staleness(row(), LiveContext.model_validate(live), 18_000)
    assert (stale.reason if stale else None) == reason


def test_lifecycle_has_no_way_back_from_terminal_states() -> None:
    assert rules.can_transition("validated", "approved")
    assert rules.can_transition("approved", "executing")
    assert not rules.can_transition("rejected", "approved")
    assert not rules.can_transition("validated", "executing")  # never without approval
    assert not rules.can_transition("applied", "executing")  # never twice
    for state in ("not_actionable", "invalid", "rejected", "applied", "failed", "expired"):
        assert rules.TRANSITIONS[state] == ()
