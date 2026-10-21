"""The Pydantic command mirror must agree with the published JSON Schema and the fixtures."""

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from warehouse_api.contracts.commands import COMMAND_ADAPTER, COMMAND_MODELS


@pytest.fixture
def schema(repo_root: Path) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        (repo_root / "data/schemas/simulation-command.schema.json").read_text()
    )
    return data


def _wire_names(model: type[BaseModel]) -> set[str]:
    return {field.alias or name for name, field in model.model_fields.items()}


def test_command_models_match_json_schema(schema: dict[str, Any]) -> None:
    variants = {v["properties"]["type"]["const"]: v for v in schema["oneOf"]}
    assert set(variants) == set(COMMAND_MODELS)
    for command_type, variant in variants.items():
        model = COMMAND_MODELS[command_type]
        assert _wire_names(model) == set(variant["properties"]), command_type
        payload = model.model_fields["payload"].annotation
        assert isinstance(payload, type) and issubclass(payload, BaseModel)
        assert _wire_names(payload) == set(variant["properties"]["payload"]["properties"]), (
            command_type
        )
        assert set(variant["properties"]["payload"]["required"]) == {
            name for name, f in payload.model_fields.items() if f.is_required()
        }, command_type


@pytest.mark.parametrize("fixture", ["foundation-demo", "operations-demo", "network-demo"])
def test_fixture_command_logs_parse(repo_root: Path, fixture: str) -> None:
    lines = (repo_root / "data/fixtures" / fixture / "commands.jsonl").read_text().splitlines()
    assert lines
    for line in lines:
        COMMAND_ADAPTER.validate_python(json.loads(line)["command"])


@pytest.mark.parametrize(
    "command",
    [
        {"command_id": "c", "type": "order.create", "payload": {"lines": []}},
        {
            "command_id": "c",
            "type": "order.create",
            "payload": {"lines": [{"sku": "a", "quantity": 27}]},
        },
        {"command_id": "", "type": "order.cancel", "payload": {"order_id": "ord-1"}},
        {"command_id": "c", "type": "inventory.teleport", "payload": {}},
        {"command_id": "c", "type": "order.cancel", "payload": {"order_id": "ord-1", "x": 1}},
    ],
)
def test_invalid_commands_are_rejected(command: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        COMMAND_ADAPTER.validate_python(command)
