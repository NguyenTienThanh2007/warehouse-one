import type { OpsDraft } from "../ops-draft";
import { TRUCK_DEPARTING_TICKS, TRUCK_DOCKING_TICKS, type TruckState } from "../model";
import type { Trace } from "../tasks";

const traceFor = (t: TruckState): Trace => ({ correlation_id: t.correlation_id, causation_id: "system:yard" });

function palletsOn(o: OpsDraft, truckId: string) {
  return o.pallets.values().filter((p) => p.at.kind === "truck" && p.at.truck_id === truckId);
}

function transition(o: OpsDraft, t: TruckState, next: TruckState): void {
  o.trucks.set(t.id, next);
  o.draft.emit(
    "truck.status_changed",
    t.id,
    { truck_id: t.id, direction: t.direction, from: t.status, to: next.status, dock_id: next.dock_id, pallet_count: palletsOn(o, t.id).length },
    traceFor(t),
  );
}

/**
 * Truck and dock lifecycle: yard → docking → docked → departing → departed.
 * - Docks are assigned first-come (lowest truck id) to the lowest free dock; a dock holds one truck.
 * - Inbound trucks leave once every pallet is unloaded; outbound trucks once their order is loaded.
 * - A dock is released only when its truck has fully departed.
 */
export function truckSystem(o: OpsDraft): void {
  for (const t of o.trucks.sorted()) {
    if (t.status === "docking" || t.status === "departing") {
      const left = t.motion_ticks_left - 1;
      if (left > 0) {
        o.trucks.set(t.id, { ...t, motion_ticks_left: left });
        continue;
      }
      if (t.status === "docking") {
        transition(o, t, { ...t, status: "docked", motion_ticks_left: 0, status_since_tick: o.tick });
        continue;
      }
      depart(o, t);
      continue;
    }
    if (t.status === "docked") {
      const cargo = palletsOn(o, t.id);
      const busy = o.tasks.values().some((task) => task.truck_id === t.id);
      const done =
        t.direction === "inbound"
          ? cargo.length === 0 && !busy
          : (() => {
              const order = t.order_id ? o.orders.get(t.order_id) : undefined;
              return !!order && !busy && order.pallet_ids.every((id) => o.pallets.get(id)?.at.kind === "truck");
            })();
      if (done) transition(o, t, { ...t, status: "departing", motion_ticks_left: TRUCK_DEPARTING_TICKS, status_since_tick: o.tick });
    }
  }

  // Assign free docks to waiting trucks, first come first served.
  const free = Object.keys(o.docks.snapshot())
    .sort()
    .filter((id) => o.docks.get(id)?.truck_id === null);
  for (const t of o.trucks.sorted().filter((x) => x.status === "yard")) {
    const dockId = free.shift();
    if (!dockId) break;
    o.docks.set(dockId, { truck_id: t.id });
    transition(o, t, { ...t, status: "docking", dock_id: dockId, motion_ticks_left: TRUCK_DOCKING_TICKS, status_since_tick: o.tick });
    const order = t.order_id ? o.orders.get(t.order_id) : undefined;
    if (order?.status === "open") {
      o.orders.set(order.id, { ...order, status: "in_progress" });
      o.draft.emit(
        "order.status_changed",
        order.id,
        { order_id: order.id, from: "open", to: "in_progress", truck_id: order.truck_id, lines: [...order.lines] },
        { correlation_id: order.correlation_id, causation_id: "system:yard" },
      );
    }
  }
}

function depart(o: OpsDraft, t: TruckState): void {
  const trace = traceFor(t);
  for (const p of palletsOn(o, t.id).sort((a, b) => a.id.localeCompare(b.id))) {
    o.removePallet(p);
    o.draft.emit("pallet.removed", p.id, { pallet_id: p.id, sku: p.sku, from: p.at, reason: "shipped" }, trace);
  }
  if (t.dock_id) o.docks.set(t.dock_id, { truck_id: null });
  o.trucks.delete(t.id);
  o.draft.emit("truck.status_changed", t.id, { truck_id: t.id, direction: t.direction, from: "departing", to: "departed", dock_id: t.dock_id, pallet_count: 0 }, trace);
  const order = t.order_id ? o.orders.get(t.order_id) : undefined;
  if (order) {
    o.orders.delete(order.id);
    o.draft.emit(
      "order.status_changed",
      order.id,
      { order_id: order.id, from: order.status, to: "shipped", truck_id: order.truck_id, lines: [...order.lines] },
      { correlation_id: order.correlation_id, causation_id: "system:yard" },
    );
  }
}
