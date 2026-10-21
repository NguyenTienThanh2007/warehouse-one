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


# Phase 2 operational vocabulary ------------------------------------------------------------

NodeId = Annotated[str, StringConstraints(min_length=1, max_length=64)]
NonNegative = Annotated[int, Field(ge=0)]
EquipmentStatus = Literal["idle", "travelling", "handling", "charging"]
TruckStatus = Literal["yard", "docking", "docked", "departing", "departed"]
OrderStatus = Literal["open", "in_progress", "shipped", "cancelled"]


class SlotPosition(_Strict):
    kind: Literal["slot"]
    location_id: EntityId
    slot: NonNegative


class StagingPosition(_Strict):
    kind: Literal["staging"]
    dock_id: EntityId
    position: NonNegative


class EquipmentPosition(_Strict):
    kind: Literal["equipment"]
    equipment_id: EntityId


class TruckPosition(_Strict):
    kind: Literal["truck"]
    truck_id: EntityId
    position: NonNegative


PalletPosition = Annotated[
    SlotPosition | StagingPosition | EquipmentPosition | TruckPosition,
    Field(discriminator="kind"),
]


class CargoLine(_Strict):
    sku: EntityId
    quantity: Annotated[int, Field(gt=0, le=26)]


class PalletCreatedPayload(_Strict):
    pallet_id: EntityId
    sku: EntityId
    at: PalletPosition
    cause: Literal["receive", "inbound_truck", "adjust"]


class PalletMovedPayload(_Strict):
    pallet_id: EntityId
    sku: EntityId
    from_: PalletPosition = Field(alias="from")
    to: PalletPosition
    task_id: EntityId | None


class PalletRemovedPayload(_Strict):
    pallet_id: EntityId
    sku: EntityId
    from_: PalletPosition = Field(alias="from")
    reason: Literal["adjust", "shipped"]


class TaskCreatedPayload(_Strict):
    task_id: EntityId
    task_type: Literal["relocate", "putaway", "pick", "load", "unload"]
    pallet_id: EntityId
    sku: EntityId
    from_: PalletPosition = Field(alias="from")
    to: PalletPosition
    order_id: EntityId | None
    truck_id: EntityId | None


class TaskAssignedPayload(_Strict):
    task_id: EntityId
    equipment_id: EntityId
    route_length_mm: NonNegative


class TaskCompletedPayload(_Strict):
    task_id: EntityId
    equipment_id: EntityId
    duration_ticks: NonNegative


class TaskCancelledPayload(_Strict):
    task_id: EntityId
    reason: Literal["order_cancelled"]


class EquipmentStatusChangedPayload(_Strict):
    equipment_id: EntityId
    from_: EquipmentStatus = Field(alias="from")
    to: EquipmentStatus
    node_id: NodeId
    task_id: EntityId | None
    battery_permille: Annotated[int, Field(ge=0, le=1000)]


class TruckStatusChangedPayload(_Strict):
    truck_id: EntityId
    direction: Literal["inbound", "outbound"]
    from_: TruckStatus | None = Field(alias="from")
    to: TruckStatus
    dock_id: EntityId | None
    pallet_count: NonNegative


class OrderStatusChangedPayload(_Strict):
    order_id: EntityId
    from_: OrderStatus | None = Field(alias="from")
    to: OrderStatus
    truck_id: EntityId
    lines: list[CargoLine]


class _Envelope(_Strict):
    event_id: UUID
    schema_version: Annotated[int, Field(gt=0)]
    aggregate_id: EntityId
    aggregate_version: Annotated[int, Field(gt=0)]
    simulation_id: UUID
    sequence: Annotated[int, Field(gt=0)]
    occurred_at: datetime
    simulation_time_ms: Annotated[int, Field(ge=0)]
    correlation_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    causation_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]


class InventoryReceived(_Envelope):
    aggregate_type: Literal["inventory_item"]
    event_type: Literal["inventory.received"]
    payload: InventoryReceivedPayload


class InventoryMoved(_Envelope):
    aggregate_type: Literal["inventory_item"]
    event_type: Literal["inventory.moved"]
    payload: InventoryMovedPayload


class InventoryAdjusted(_Envelope):
    aggregate_type: Literal["inventory_item"]
    event_type: Literal["inventory.adjusted"]
    payload: InventoryAdjustedPayload


class PalletCreated(_Envelope):
    aggregate_type: Literal["pallet"]
    event_type: Literal["pallet.created"]
    payload: PalletCreatedPayload


class PalletMoved(_Envelope):
    aggregate_type: Literal["pallet"]
    event_type: Literal["pallet.moved"]
    payload: PalletMovedPayload


class PalletRemoved(_Envelope):
    aggregate_type: Literal["pallet"]
    event_type: Literal["pallet.removed"]
    payload: PalletRemovedPayload


class TaskCreated(_Envelope):
    aggregate_type: Literal["task"]
    event_type: Literal["task.created"]
    payload: TaskCreatedPayload


class TaskAssigned(_Envelope):
    aggregate_type: Literal["task"]
    event_type: Literal["task.assigned"]
    payload: TaskAssignedPayload


class TaskCompleted(_Envelope):
    aggregate_type: Literal["task"]
    event_type: Literal["task.completed"]
    payload: TaskCompletedPayload


class TaskCancelled(_Envelope):
    aggregate_type: Literal["task"]
    event_type: Literal["task.cancelled"]
    payload: TaskCancelledPayload


class EquipmentStatusChanged(_Envelope):
    aggregate_type: Literal["equipment"]
    event_type: Literal["equipment.status_changed"]
    payload: EquipmentStatusChangedPayload


class TruckStatusChanged(_Envelope):
    aggregate_type: Literal["truck"]
    event_type: Literal["truck.status_changed"]
    payload: TruckStatusChangedPayload


class OrderStatusChanged(_Envelope):
    aggregate_type: Literal["order"]
    event_type: Literal["order.status_changed"]
    payload: OrderStatusChangedPayload


AnyEvent = (
    InventoryReceived
    | InventoryMoved
    | InventoryAdjusted
    | PalletCreated
    | PalletMoved
    | PalletRemoved
    | TaskCreated
    | TaskAssigned
    | TaskCompleted
    | TaskCancelled
    | EquipmentStatusChanged
    | TruckStatusChanged
    | OrderStatusChanged
)
DomainEvent = Annotated[AnyEvent, Field(discriminator="event_type")]
domain_event_adapter: TypeAdapter[DomainEvent] = TypeAdapter(DomainEvent)

EVENT_MODELS: dict[str, type[_Envelope]] = {
    "inventory.received": InventoryReceived,
    "inventory.moved": InventoryMoved,
    "inventory.adjusted": InventoryAdjusted,
    "pallet.created": PalletCreated,
    "pallet.moved": PalletMoved,
    "pallet.removed": PalletRemoved,
    "task.created": TaskCreated,
    "task.assigned": TaskAssigned,
    "task.completed": TaskCompleted,
    "task.cancelled": TaskCancelled,
    "equipment.status_changed": EquipmentStatusChanged,
    "truck.status_changed": TruckStatusChanged,
    "order.status_changed": OrderStatusChanged,
}


def parse_event(raw: str | bytes) -> AnyEvent:
    """Parse one JSON-encoded event. Raises pydantic.ValidationError on contract violations."""
    return domain_event_adapter.validate_json(raw)
