"""The Python port of the simulation's deterministic event IDs must agree with TypeScript."""

import json
from pathlib import Path

import pytest

from warehouse_api.contracts.identity import cyrb128, deterministic_uuid

FIXTURES = ["foundation-demo", "operations-demo", "network-demo"]


@pytest.mark.parametrize("fixture", FIXTURES)
def test_every_fixture_event_id_is_reproduced(repo_root: Path, fixture: str) -> None:
    lines = (repo_root / "data/fixtures" / fixture / "events.jsonl").read_text().splitlines()
    assert len(lines) > 100
    for line in lines:
        event = json.loads(line)
        expected = deterministic_uuid(event["simulation_id"], event["sequence"])
        assert event["event_id"] == expected, event["sequence"]


def test_cyrb128_matches_known_values() -> None:
    # Values computed with packages/simulation/src/hash.ts under Node 24, pinned here.
    assert cyrb128("") == (41608494, 3485963809, 1435736333, 1262568316)
    assert deterministic_uuid("scenario:showcase", 0) == "a4394472-b402-893f-a58a-ae1fabed39d1"


def test_non_ascii_input_uses_utf16_code_units() -> None:
    # A BMP character, and an astral character (a surrogate pair in UTF-16), as in JavaScript.
    assert cyrb128("é") == (1621247514, 3528421196, 473986565, 5574360)
    assert deterministic_uuid("😀", 1) == "fa360d64-c25d-8d16-8e81-b9346a442196"
