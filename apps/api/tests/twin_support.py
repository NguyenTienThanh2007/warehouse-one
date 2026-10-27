"""Evaluations produced by the TypeScript optimiser (data/fixtures/twin-standby), for API tests."""

import copy
import json
from functools import cache
from typing import Any

from tests.conftest import REPO_ROOT

FIXTURES = REPO_ROOT / "data/fixtures/twin-standby"


@cache
def _load(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / name).read_text())
    return data


def snapshot() -> dict[str, Any]:
    return copy.deepcopy(_load("snapshot.json"))


def recommended() -> dict[str, Any]:
    return copy.deepcopy(_load("evaluation-recommended.json"))


def unchanged() -> dict[str, Any]:
    return copy.deepcopy(_load("evaluation-unchanged.json"))


def body(evaluation: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
    return {"evaluation": evaluation or recommended(), "snapshot": snapshot(), **extra}


def chosen(evaluation: dict[str, Any]) -> dict[str, Any]:
    rec_id = evaluation["recommendation"]["candidate_id"]
    candidate: dict[str, Any] = next(
        c for c in evaluation["candidates"] if c["candidate_id"] == rec_id
    )
    return candidate


def live(
    evaluation: dict[str, Any] | None = None, ticks_later: int = 100, **over: Any
) -> dict[str, Any]:
    """The live run's context a moment after the evaluated state (fresh unless overridden)."""
    src = (evaluation or recommended())["source"]
    return {
        "simulation_id": src["simulation_id"],
        "config_hash": src["config_hash"],
        "tick": src["tick"] + ticks_later,
        "fleet_fingerprint": src["fleet_fingerprint"],
        **over,
    }


def with_new_id(evaluation: dict[str, Any], suffix: str) -> dict[str, Any]:
    """The same evaluation under another (valid) id, to store it as a second proposal."""
    e = copy.deepcopy(evaluation)
    e["evaluation_id"] = e["evaluation_id"][: -len(suffix)] + suffix
    return e
