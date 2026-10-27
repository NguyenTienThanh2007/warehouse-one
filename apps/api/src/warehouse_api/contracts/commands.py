"""Pydantic mirror of the simulation command contract.

Source of truth: packages/contracts/src/commands.ts, published as
data/schemas/simulation-command.schema.json. tests/test_command_contract.py fails on drift. The API
stores a run's command log so a run can be replayed in the TypeScript engine; it validates the
shape of each command, not its business effect (the engine decides that during replay).
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter

from warehouse_api.contracts.events import EntityId, Quantity

CommandId = Annotated[str, StringConstraints(min_length=1, max_length=128)]
TruckQuantity = Annotated[int, Field(gt=0, le=26)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CargoLine(_Strict):
    sku: EntityId
    quantity: TruckQuantity


CargoLines = Annotated[list[CargoLine], Field(min_length=1, max_length=8)]


class ReceiveInventoryPayload(_Strict):
    location_id: EntityId
    sku: EntityId
    quantity: Quantity


class MoveInventoryPayload(_Strict):
    from_location_id: EntityId
    to_location_id: EntityId
    sku: EntityId
    quantity: Quantity


class AdjustInventoryPayload(_Strict):
    location_id: EntityId
    sku: EntityId
    delta: Annotated[int, Field(ge=-1_000_000, le=1_000_000)]
    reason: Literal["cycle_count", "damage", "correction"]


class ScheduleInboundTruckPayload(_Strict):
    cargo: CargoLines


class CreateOrderPayload(_Strict):
    lines: CargoLines


class CancelOrderPayload(_Strict):
    order_id: EntityId


class RelocatePalletPayload(_Strict):
    pallet_id: EntityId
    to_location_id: EntityId


class RequestTransferPayload(_Strict):
    from_site_id: EntityId
    to_site_id: EntityId
    lines: CargoLines


class SetStandbyPayload(_Strict):
    vehicle_id: EntityId
    # Required but nullable: null sends the truck back to its home stall at the depot.
    site_id: EntityId | None


class ReceiveInventoryCommand(_Strict):
    command_id: CommandId
    type: Literal["inventory.receive"]
    payload: ReceiveInventoryPayload


class MoveInventoryCommand(_Strict):
    command_id: CommandId
    type: Literal["inventory.move"]
    payload: MoveInventoryPayload


class AdjustInventoryCommand(_Strict):
    command_id: CommandId
    type: Literal["inventory.adjust"]
    payload: AdjustInventoryPayload


class ScheduleInboundTruckCommand(_Strict):
    command_id: CommandId
    type: Literal["truck.schedule_inbound"]
    payload: ScheduleInboundTruckPayload


class CreateOrderCommand(_Strict):
    command_id: CommandId
    type: Literal["order.create"]
    payload: CreateOrderPayload


class CancelOrderCommand(_Strict):
    command_id: CommandId
    type: Literal["order.cancel"]
    payload: CancelOrderPayload


class RelocatePalletCommand(_Strict):
    command_id: CommandId
    type: Literal["pallet.relocate"]
    payload: RelocatePalletPayload


class RequestTransferCommand(_Strict):
    command_id: CommandId
    type: Literal["transfer.request"]
    payload: RequestTransferPayload


class SetStandbyCommand(_Strict):
    command_id: CommandId
    type: Literal["linehaul.set_standby"]
    payload: SetStandbyPayload


SimulationCommand = Annotated[
    ReceiveInventoryCommand
    | MoveInventoryCommand
    | AdjustInventoryCommand
    | ScheduleInboundTruckCommand
    | CreateOrderCommand
    | CancelOrderCommand
    | RelocatePalletCommand
    | RequestTransferCommand
    | SetStandbyCommand,
    Field(discriminator="type"),
]

COMMAND_MODELS: dict[str, type[BaseModel]] = {
    "inventory.receive": ReceiveInventoryCommand,
    "inventory.move": MoveInventoryCommand,
    "inventory.adjust": AdjustInventoryCommand,
    "truck.schedule_inbound": ScheduleInboundTruckCommand,
    "order.create": CreateOrderCommand,
    "order.cancel": CancelOrderCommand,
    "pallet.relocate": RelocatePalletCommand,
    "transfer.request": RequestTransferCommand,
    "linehaul.set_standby": SetStandbyCommand,
}

COMMAND_ADAPTER: TypeAdapter[SimulationCommand] = TypeAdapter(SimulationCommand)
