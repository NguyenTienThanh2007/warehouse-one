"""Cross-language contract tests.

The TypeScript simulation produces data/fixtures/foundation-demo/events.jsonl and publishes the
JSON Schema in data/schemas. These tests prove that Python consumers agree with both, and run the
same reconciliation the Phase 3 pipeline will automate (event fold == simulation's final totals).
"""

import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import BaseModel, ValidationError

from warehouse_api.contracts.events import EVENT_MODELS, parse_event


@pytest.fixture(scope="module")
def schema(request: pytest.FixtureRequest) -> dict[str, Any]:
    root = Path(request.config.rootpath).resolve().parents[1]
    data: dict[str, Any] = json.loads((root / "data/schemas/domain-event.schema.json").read_text())
    return data


@pytest.fixture(scope="module")
def fixture_dir(request: pytest.FixtureRequest) -> Path:
    return Path(request.config.rootpath).resolve().parents[1] / "data/fixtures/foundation-demo"


@pytest.fixture(scope="module")
def raw_events(fixture_dir: Path) -> list[str]:
    return (fixture_dir / "events.jsonl").read_text().splitlines()


def test_fixture_events_satisfy_json_schema(schema: dict[str, Any], raw_events: list[str]) -> None:
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    assert raw_events, "fixture must not be empty"
    for line in raw_events:
        errors = list(validator.iter_errors(json.loads(line)))
        assert errors == [], errors[0].message if errors else ""


def test_fixture_events_parse_with_pydantic(raw_events: list[str]) -> None:
    parsed = [parse_event(line) for line in raw_events]
    assert {e.event_type for e in parsed} <= set(EVENT_MODELS)


def _wire_names(model: type[BaseModel]) -> set[str]:
    """JSON field names: the alias where one exists (`from` is a Python keyword, so `from_`)."""
    return {field.alias or name for name, field in model.model_fields.items()}


def test_pydantic_models_match_json_schema_fields(schema: dict[str, Any]) -> None:
    assert {v["properties"]["event_type"]["const"] for v in schema["oneOf"]} == set(EVENT_MODELS)
    for variant in schema["oneOf"]:
        event_type = variant["properties"]["event_type"]["const"]
        model = EVENT_MODELS[event_type]
        assert _wire_names(model) == set(variant["properties"]), event_type
        assert set(variant["required"]) == set(variant["properties"]), event_type
        payload_model = model.model_fields["payload"].annotation
        assert isinstance(payload_model, type) and issubclass(payload_model, BaseModel)
        assert _wire_names(payload_model) == set(variant["properties"]["payload"]["properties"]), (
            event_type
        )
        aggregate = variant["properties"]["aggregate_type"]["const"]
        literal = model.model_fields["aggregate_type"].annotation
        assert getattr(literal, "__args__", None) == (aggregate,), event_type


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        ({"event_type": "inventory.teleported"}, "unknown event type"),
        ({"sequence": 0}, "sequence must be positive"),
        ({"extra_field": 1}, "unknown fields are rejected"),
        ({"event_id": "not-a-uuid"}, "event_id must be a UUID"),
    ],
)
def test_invalid_events_are_rejected(
    raw_events: list[str], mutation: dict[str, Any], reason: str
) -> None:
    event = json.loads(raw_events[0]) | mutation
    with pytest.raises(ValidationError):
        parse_event(json.dumps(event))


def test_ordering_and_time_semantics(raw_events: list[str], fixture_dir: Path) -> None:
    events = [parse_event(line) for line in raw_events]
    config = json.loads((fixture_dir / "config.json").read_text())
    epoch = datetime.fromisoformat(config["epoch"])
    assert [e.sequence for e in events] == list(range(1, len(events) + 1))
    assert len({e.event_id for e in events}) == len(events)
    versions: dict[str, int] = defaultdict(int)
    for e in events:
        versions[e.aggregate_id] += 1
        assert e.aggregate_version == versions[e.aggregate_id]
        assert e.occurred_at == epoch + timedelta(milliseconds=e.simulation_time_ms)


def test_event_fold_reconciles_with_simulation_totals(
    raw_events: list[str], fixture_dir: Path
) -> None:
    summary = json.loads((fixture_dir / "summary.json").read_text())
    stock: dict[tuple[str, str], int] = Counter()
    for event in map(parse_event, raw_events):
        p = event.payload
        match event.event_type:
            case "inventory.received":
                stock[(p.location_id, p.sku)] += p.quantity  # type: ignore[union-attr]
            case "inventory.moved":
                stock[(p.from_location_id, p.sku)] -= p.quantity  # type: ignore[union-attr]
                stock[(p.to_location_id, p.sku)] += p.quantity  # type: ignore[union-attr]
            case "inventory.adjusted":
                stock[(p.location_id, p.sku)] += p.delta  # type: ignore[union-attr]
        assert all(q >= 0 for q in stock.values()), "stock went negative mid-stream"
    totals: dict[str, int] = Counter()
    for (_, sku), qty in stock.items():
        totals[sku] += qty
    assert {k: v for k, v in totals.items() if v} == summary["final_totals_by_sku"]
    assert len(raw_events) == summary["event_count"]
