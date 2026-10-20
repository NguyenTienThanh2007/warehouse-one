"""Pydantic mirror of the domain event contract.

The source of truth is packages/contracts (TypeScript/Zod), published as JSON Schema in
data/schemas/domain-event.schema.json. tests/test_event_contract.py fails if these models drift
from that schema, so consumers in Python can rely on them.
"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter

EntityId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,63}$")]
Quantity = Annotated[int, Field(gt=0, le=1_000_000)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class InventoryReceivedPayload(_Strict):
    location_id: EntityId
    sku: EntityId
    quantity: Quantity
    location_quantity_after: Annotated[int, Field(ge=0)]


class InventoryMovedPayload(_Strict):
    from_location_id: EntityId
    to_location_id: EntityId
    sku: EntityId
    quantity: Quantity


class InventoryAdjustedPayload(_Strict):
    location_id: EntityId
    sku: EntityId
    delta: int
    reason: Literal["cycle_count", "damage", "correction"]
    location_quantity_after: Annotated[int, Field(ge=0)]


class _Envelope(_Strict):
    event_id: UUID
    schema_version: Annotated[int, Field(gt=0)]
    aggregate_type: Literal["inventory_item"]
    aggregate_id: EntityId
    aggregate_version: Annotated[int, Field(gt=0)]
    simulation_id: UUID
    sequence: Annotated[int, Field(gt=0)]
    occurred_at: datetime
    simulation_time_ms: Annotated[int, Field(ge=0)]
    correlation_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    causation_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class InventoryReceived(_Envelope):
    event_type: Literal["inventory.received"]
    payload: InventoryReceivedPayload


class InventoryMoved(_Envelope):
    event_type: Literal["inventory.moved"]
    payload: InventoryMovedPayload


class InventoryAdjusted(_Envelope):
    event_type: Literal["inventory.adjusted"]
    payload: InventoryAdjustedPayload


DomainEvent = Annotated[
    InventoryReceived | InventoryMoved | InventoryAdjusted, Field(discriminator="event_type")
]
domain_event_adapter: TypeAdapter[DomainEvent] = TypeAdapter(DomainEvent)

EVENT_MODELS: dict[str, type[_Envelope]] = {
    "inventory.received": InventoryReceived,
    "inventory.moved": InventoryMoved,
    "inventory.adjusted": InventoryAdjusted,
}


def parse_event(raw: str | bytes) -> InventoryReceived | InventoryMoved | InventoryAdjusted:
    """Parse one JSON-encoded event. Raises pydantic.ValidationError on contract violations."""
    return domain_event_adapter.validate_json(raw)
