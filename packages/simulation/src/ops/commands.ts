import type {
  AdjustInventoryCommand,
  CancelOrderCommand,
  CreateOrderCommand,
  MoveInventoryCommand,
  ReceiveInventoryCommand,
  RelocatePalletCommand,
  ScheduleInboundTruckCommand,
  SimulationCommand,
} from "@warehouse-one/contracts";
import type { RejectionCode } from "../types";
import type { OpsDraft } from "./ops-draft";
import { TRUCK_DEPARTING_TICKS, type PalletState } from "./model";
import {
  availablePallets,
  createTask,
  freeStorage,
  freeYardSlot,
  inboundBacklog,
  palletsInLocation,
  type Trace,
} from "./tasks";

export type OpsResult = { ok: true } | { ok: false; code: RejectionCode; message: string };
const OK: OpsResult = { ok: true };
const reject = (code: RejectionCode, message: string): OpsResult => ({ ok: false, code, message });

/**
 * Command handlers for facilities with operations (Phase 2). Each handler validates everything
 * before its first write, so a rejected command never leaves partial state.
 */
export function applyOpsCommand(o: OpsDraft, command: SimulationCommand, trace: Trace): OpsResult {
  switch (command.type) {
    case "inventory.receive":
      return receive(o, command.payload, trace);
    case "inventory.move":
      return move(o, command.payload, trace);
    case "inventory.adjust":
      return adjust(o, command.payload, trace);
    case "truck.schedule_inbound":
      return scheduleInbound(o, command.payload, trace);
    case "order.create":
      return createOrder(o, command.payload, trace);
    case "order.cancel":
      return cancelOrder(o, command.payload, trace);
    case "pallet.relocate":
      return relocate(o, command.payload, trace);
  }
}

function checkLocation(o: OpsDraft, id: string): OpsResult {
  return o.draft.locationIndex.has(id) ? OK : reject("UNKNOWN_LOCATION", `unknown location '${id}'`);
}
function checkSku(o: OpsDraft, sku: string): OpsResult {
  return o.draft.skuIds.has(sku) ? OK : reject("UNKNOWN_SKU", `unknown sku '${sku}'`);
}

function createPallets(o: OpsDraft, sku: string, positions: PalletState["at"][], cause: "receive" | "inbound_truck" | "adjust", trace: Trace) {
  const created: PalletState[] = [];
  for (const at of positions) {
    const pallet: PalletState = { id: o.newId("pallet"), sku, at, order_id: null, task_id: null };
    o.placePallet(pallet);
    created.push(pallet);
  }
  for (const p of created) o.draft.emit("pallet.created", p.id, { pallet_id: p.id, sku, at: p.at, cause }, trace);
}

function receive(o: OpsDraft, p: ReceiveInventoryCommand["payload"], trace: Trace): OpsResult {
  const refs = checkLocation(o, p.location_id);
  if (!refs.ok) return refs;
  const sku = checkSku(o, p.sku);
  if (!sku.ok) return sku;
  const free = o.freeSlots(p.location_id);
  if (p.quantity > free.length) {
    return reject("CAPACITY_EXCEEDED", `location '${p.location_id}' has ${free.length} free positions, needs ${p.quantity}`);
  }
  const positions = free.slice(0, p.quantity).map((slot) => ({ kind: "slot" as const, location_id: p.location_id, slot }));
  // Account for the projection change before emitting the SKU-level ledger event.
  const before = o.draft.quantity(p.location_id, p.sku);
  o.draft.emit("inventory.received", p.sku, { ...p, location_quantity_after: before + p.quantity }, trace);
  createPallets(o, p.sku, positions, "receive", trace);
  return OK;
}

/** Unallocated pallets of a SKU in a location, highest slot first (taken from the top). */
function movable(o: OpsDraft, locationId: string, sku: string): PalletState[] {
  return palletsInLocation(o, locationId)
    .filter((x) => x.sku === sku && !x.order_id && !x.task_id)
    .reverse();
}

function move(o: OpsDraft, p: MoveInventoryCommand["payload"], trace: Trace): OpsResult {
  for (const id of [p.from_location_id, p.to_location_id]) {
    const r = checkLocation(o, id);
    if (!r.ok) return r;
  }
  const sku = checkSku(o, p.sku);
  if (!sku.ok) return sku;
  const held = o.draft.quantity(p.from_location_id, p.sku);
  if (held < p.quantity) {
    return reject("INSUFFICIENT_STOCK", `'${p.from_location_id}' holds ${held} of '${p.sku}', needs ${p.quantity}`);
  }
  const candidates = movable(o, p.from_location_id, p.sku);
  if (candidates.length < p.quantity) {
    return reject("PALLET_RESERVED", `only ${candidates.length} of ${held} '${p.sku}' pallets in '${p.from_location_id}' are unallocated`);
  }
  const free = o.freeSlots(p.to_location_id);
  if (free.length < p.quantity) {
    return reject("CAPACITY_EXCEEDED", `location '${p.to_location_id}' has ${free.length} free positions, needs ${p.quantity}`);
  }
  o.draft.emit("inventory.moved", p.sku, { ...p }, trace);
  candidates.slice(0, p.quantity).forEach((pallet, i) => {
    const to = { kind: "slot" as const, location_id: p.to_location_id, slot: free[i] as number };
    o.placePallet({ ...pallet, at: to }, pallet);
    o.draft.emit("pallet.moved", pallet.id, { pallet_id: pallet.id, sku: pallet.sku, from: pallet.at, to, task_id: null }, trace);
  });
  return OK;
}

function adjust(o: OpsDraft, p: AdjustInventoryCommand["payload"], trace: Trace): OpsResult {
  const refs = checkLocation(o, p.location_id);
  if (!refs.ok) return refs;
  const sku = checkSku(o, p.sku);
  if (!sku.ok) return sku;
  const before = o.draft.quantity(p.location_id, p.sku);
  if (p.delta < 0) {
    const n = -p.delta;
    if (before < n) return reject("INSUFFICIENT_STOCK", `adjustment would make '${p.location_id}/${p.sku}' negative (${before - n})`);
    const candidates = movable(o, p.location_id, p.sku);
    if (candidates.length < n) return reject("PALLET_RESERVED", `only ${candidates.length} '${p.sku}' pallets in '${p.location_id}' are unallocated`);
    o.draft.emit("inventory.adjusted", p.sku, { ...p, location_quantity_after: before - n }, trace);
    for (const pallet of candidates.slice(0, n)) {
      o.removePallet(pallet);
      o.draft.emit("pallet.removed", pallet.id, { pallet_id: pallet.id, sku: pallet.sku, from: pallet.at, reason: "adjust" }, trace);
    }
    return OK;
  }
  const free = o.freeSlots(p.location_id);
  if (free.length < p.delta) return reject("CAPACITY_EXCEEDED", `adjustment exceeds capacity of '${p.location_id}'`);
  o.draft.emit("inventory.adjusted", p.sku, { ...p, location_quantity_after: before + p.delta }, trace);
  createPallets(
    o,
    p.sku,
    free.slice(0, p.delta).map((slot) => ({ kind: "slot" as const, location_id: p.location_id, slot })),
    "adjust",
    trace,
  );
  return OK;
}

function scheduleInbound(o: OpsDraft, p: ScheduleInboundTruckCommand["payload"], trace: Trace): OpsResult {
  for (const line of p.cargo) {
    const r = checkSku(o, line.sku);
    if (!r.ok) return r;
  }
  const total = p.cargo.reduce((n, l) => n + l.quantity, 0);
  const capacity = freeStorage(o) - inboundBacklog(o);
  if (total > capacity) {
    return reject("NO_CAPACITY", `storage can take ${Math.max(0, capacity)} more inbound pallets, truck carries ${total}`);
  }
  const yardSlot = freeYardSlot(o);
  if (yardSlot === null) return reject("YARD_FULL", "every yard slot is taken; wait for a truck to dock or leave");
  const id = o.newId("truck");
  o.trucks.set(id, {
    id,
    direction: "inbound",
    status: "yard",
    dock_id: null,
    yard_slot: yardSlot,
    order_id: null,
    motion_ticks_left: 0,
    status_since_tick: o.tick,
    correlation_id: trace.correlation_id,
  });
  o.draft.emit("truck.status_changed", id, { truck_id: id, direction: "inbound", from: null, to: "yard", dock_id: null, pallet_count: total }, trace);
  let position = 0;
  for (const line of p.cargo) {
    const positions = Array.from({ length: line.quantity }, () => ({ kind: "truck" as const, truck_id: id, position: position++ }));
    createPallets(o, line.sku, positions, "inbound_truck", trace);
  }
  return OK;
}

function createOrder(o: OpsDraft, p: CreateOrderCommand["payload"], trace: Trace): OpsResult {
  const allocation: PalletState[] = [];
  for (const line of p.lines) {
    const r = checkSku(o, line.sku);
    if (!r.ok) return r;
    const available = availablePallets(o, line.sku);
    if (available.length < line.quantity) {
      return reject("INSUFFICIENT_STOCK", `'${line.sku}': ${available.length} pallets available, ${line.quantity} requested`);
    }
    allocation.push(...available.slice(0, line.quantity));
  }
  const yardSlot = freeYardSlot(o);
  if (yardSlot === null) return reject("YARD_FULL", "every yard slot is taken; wait for a truck to dock or leave");
  const orderId = o.newId("order");
  const truckId = o.newId("truck");
  for (const pallet of allocation) o.updatePallet(pallet.id, { order_id: orderId });
  o.orders.set(orderId, {
    id: orderId,
    status: "open",
    truck_id: truckId,
    lines: p.lines,
    pallet_ids: allocation.map((x) => x.id),
    created_tick: o.tick,
    correlation_id: trace.correlation_id,
  });
  o.trucks.set(truckId, {
    id: truckId,
    direction: "outbound",
    status: "yard",
    dock_id: null,
    yard_slot: yardSlot,
    order_id: orderId,
    motion_ticks_left: 0,
    status_since_tick: o.tick,
    correlation_id: trace.correlation_id,
  });
  o.draft.emit("order.status_changed", orderId, { order_id: orderId, from: null, to: "open", truck_id: truckId, lines: p.lines }, trace);
  o.draft.emit("truck.status_changed", truckId, { truck_id: truckId, direction: "outbound", from: null, to: "yard", dock_id: null, pallet_count: 0 }, trace);
  return OK;
}

function cancelOrder(o: OpsDraft, p: CancelOrderCommand["payload"], trace: Trace): OpsResult {
  const order = o.orders.get(p.order_id);
  if (!order) return reject("UNKNOWN_ORDER", `unknown or already finished order '${p.order_id}'`);
  if (order.status !== "open") {
    return reject("ORDER_NOT_CANCELLABLE", `order '${p.order_id}' is ${order.status}: its truck already has a dock and picking has started`);
  }
  for (const id of order.pallet_ids) o.updatePallet(id, { order_id: null });
  o.orders.delete(order.id);
  o.draft.emit("order.status_changed", order.id, { order_id: order.id, from: "open", to: "cancelled", truck_id: order.truck_id, lines: [...order.lines] }, trace);
  const truck = o.trucks.get(order.truck_id);
  if (truck) {
    o.trucks.set(truck.id, { ...truck, status: "departing", motion_ticks_left: TRUCK_DEPARTING_TICKS, status_since_tick: o.tick });
    o.draft.emit("truck.status_changed", truck.id, { truck_id: truck.id, direction: truck.direction, from: truck.status, to: "departing", dock_id: null, pallet_count: 0 }, trace);
  }
  return OK;
}

function relocate(o: OpsDraft, p: RelocatePalletCommand["payload"], trace: Trace): OpsResult {
  const pallet = o.pallets.get(p.pallet_id);
  if (!pallet) return reject("UNKNOWN_PALLET", `unknown pallet '${p.pallet_id}'`);
  if (pallet.at.kind !== "slot") return reject("PALLET_NOT_STORED", `pallet '${p.pallet_id}' is not in a rack slot (${pallet.at.kind})`);
  if (pallet.order_id || pallet.task_id) {
    return reject("PALLET_RESERVED", `pallet '${p.pallet_id}' is allocated to ${pallet.task_id ?? pallet.order_id}`);
  }
  const loc = checkLocation(o, p.to_location_id);
  if (!loc.ok) return loc;
  if (pallet.at.location_id === p.to_location_id) return reject("SAME_LOCATION", `pallet '${p.pallet_id}' is already in '${p.to_location_id}'`);
  const slot = o.freeSlots(p.to_location_id)[0];
  if (slot === undefined) return reject("NO_CAPACITY", `location '${p.to_location_id}' has no free position`);
  createTask(o, "relocate", pallet, { kind: "slot", location_id: p.to_location_id, slot }, { order_id: null, truck_id: null }, trace);
  return OK;
}
