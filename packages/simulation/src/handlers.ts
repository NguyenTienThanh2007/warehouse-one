import type {
  AdjustInventoryCommand,
  MoveInventoryCommand,
  ReceiveInventoryCommand,
  SimulationCommand,
} from "@warehouse-one/contracts";
import type { TickDraft } from "./draft";
import type { RejectionCode } from "./types";

export type HandlerResult = { ok: true } | { ok: false; code: RejectionCode; message: string };

const reject = (code: RejectionCode, message: string): HandlerResult => ({
  ok: false,
  code,
  message,
});
const OK: HandlerResult = { ok: true };

interface Trace {
  correlation_id: string;
  causation_id: string;
}

function checkRefs(d: TickDraft, sku: string, ...locations: string[]): HandlerResult {
  for (const id of locations) {
    if (!d.locationIndex.has(id)) return reject("UNKNOWN_LOCATION", `unknown location '${id}'`);
  }
  if (!d.skuIds.has(sku)) return reject("UNKNOWN_SKU", `unknown sku '${sku}'`);
  return OK;
}

function freeCapacity(d: TickDraft, locationId: string): number {
  const loc = d.locationIndex.get(locationId);
  return loc ? loc.capacity - d.locationTotal(locationId) : 0;
}

export function receive(
  d: TickDraft,
  p: ReceiveInventoryCommand["payload"],
  trace: Trace,
): HandlerResult {
  const refs = checkRefs(d, p.sku, p.location_id);
  if (!refs.ok) return refs;
  const free = freeCapacity(d, p.location_id);
  if (p.quantity > free) {
    return reject(
      "CAPACITY_EXCEEDED",
      `location '${p.location_id}' has ${free} free, needs ${p.quantity}`,
    );
  }
  const after = d.quantity(p.location_id, p.sku) + p.quantity;
  d.setQuantity(p.location_id, p.sku, after);
  d.emit("inventory.received", p.sku, { ...p, location_quantity_after: after }, trace);
  return OK;
}

export function move(
  d: TickDraft,
  p: MoveInventoryCommand["payload"],
  trace: Trace,
): HandlerResult {
  const refs = checkRefs(d, p.sku, p.from_location_id, p.to_location_id);
  if (!refs.ok) return refs;
  if (p.from_location_id === p.to_location_id) {
    return reject("INVALID_COMMAND", "from and to locations must differ");
  }
  const available = d.quantity(p.from_location_id, p.sku);
  if (available < p.quantity) {
    return reject(
      "INSUFFICIENT_STOCK",
      `'${p.from_location_id}' holds ${available} of '${p.sku}', needs ${p.quantity}`,
    );
  }
  const free = freeCapacity(d, p.to_location_id);
  if (p.quantity > free) {
    return reject(
      "CAPACITY_EXCEEDED",
      `location '${p.to_location_id}' has ${free} free, needs ${p.quantity}`,
    );
  }
  d.setQuantity(p.from_location_id, p.sku, available - p.quantity);
  d.setQuantity(p.to_location_id, p.sku, d.quantity(p.to_location_id, p.sku) + p.quantity);
  d.emit("inventory.moved", p.sku, { ...p }, trace);
  return OK;
}

export function adjust(
  d: TickDraft,
  p: AdjustInventoryCommand["payload"],
  trace: Trace,
): HandlerResult {
  const refs = checkRefs(d, p.sku, p.location_id);
  if (!refs.ok) return refs;
  const after = d.quantity(p.location_id, p.sku) + p.delta;
  if (after < 0) {
    return reject(
      "INSUFFICIENT_STOCK",
      `adjustment would make '${p.location_id}/${p.sku}' negative (${after})`,
    );
  }
  if (p.delta > 0 && p.delta > freeCapacity(d, p.location_id)) {
    return reject("CAPACITY_EXCEEDED", `adjustment exceeds capacity of '${p.location_id}'`);
  }
  d.setQuantity(p.location_id, p.sku, after);
  d.emit("inventory.adjusted", p.sku, { ...p, location_quantity_after: after }, trace);
  return OK;
}

export function applyCommand(d: TickDraft, command: SimulationCommand): HandlerResult {
  const trace = { correlation_id: command.command_id, causation_id: command.command_id };
  switch (command.type) {
    case "inventory.receive":
      return receive(d, command.payload, trace);
    case "inventory.move":
      return move(d, command.payload, trace);
    case "inventory.adjust":
      return adjust(d, command.payload, trace);
  }
}
