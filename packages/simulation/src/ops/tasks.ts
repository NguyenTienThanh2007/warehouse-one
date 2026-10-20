import type { PalletPosition, TaskType } from "@warehouse-one/contracts";
import type { OpsDraft } from "./ops-draft";
import { positionKey, type PalletState, type TaskState } from "./model";
import { shortestPaths } from "./nav";

export interface Trace {
  correlation_id: string;
  causation_id: string;
}

/** Trace for events produced by an operations system rather than a command. */
export function systemTrace(o: OpsDraft, system: string, correlation_id = `sys-ops-t${o.tick}`): Trace {
  return { correlation_id, causation_id: `system:${system}` };
}

/** The navigation node where a vehicle handles a pallet at this position. */
export function nodeFor(o: OpsDraft, p: PalletPosition): string | null {
  switch (p.kind) {
    case "slot":
      return o.graph.pickNode.get(p.location_id) ?? null;
    case "staging":
      return o.graph.laneNodes.get(p.dock_id)?.[p.position] ?? null;
    case "truck": {
      const dock = o.trucks.get(p.truck_id)?.dock_id;
      return dock ? (o.graph.doorNode.get(dock) ?? null) : null;
    }
    case "equipment":
      return null;
  }
}

/** Create a pending task: reserve the destination, mark the pallet, emit `task.created`. */
export function createTask(
  o: OpsDraft,
  type: TaskType,
  pallet: PalletState,
  to: PalletPosition,
  links: { order_id: string | null; truck_id: string | null },
  trace: Trace,
): TaskState {
  if (!o.isFree(to)) throw new Error(`invariant violated: task destination ${positionKey(to)} is not free`);
  if (pallet.task_id) throw new Error(`invariant violated: pallet ${pallet.id} already has task ${pallet.task_id}`);
  const id = o.newId("task");
  const task: TaskState = {
    id,
    type,
    status: "pending",
    pallet_id: pallet.id,
    sku: pallet.sku,
    from: pallet.at,
    to,
    equipment_id: null,
    order_id: links.order_id,
    truck_id: links.truck_id,
    created_tick: o.tick,
    correlation_id: trace.correlation_id,
  };
  o.tasks.set(id, task);
  o.reservations.set(positionKey(to), id);
  o.updatePallet(pallet.id, { task_id: id });
  o.draft.emit(
    "task.created",
    id,
    { task_id: id, task_type: type, pallet_id: pallet.id, sku: pallet.sku, from: pallet.at, to, order_id: links.order_id, truck_id: links.truck_id },
    trace,
  );
  return task;
}

/**
 * Closest free rack slot to a node by travel distance; ties go to the earlier location in the
 * config, then the lowest slot (bottom-up). Returns null when storage is full.
 */
export function nearestFreeSlot(o: OpsDraft, fromNode: string, excludeLocation?: string): { location_id: string; slot: number } | null {
  const distance = shortestPaths(o.graph, fromNode).distance;
  const ranked = o.draft.config.locations
    .map((l, i) => ({ id: l.id, i, d: distance.get(o.graph.pickNode.get(l.id) ?? "") ?? Infinity }))
    .filter((c) => c.id !== excludeLocation && c.d < Infinity)
    .sort((a, b) => a.d - b.d || a.i - b.i);
  for (const c of ranked) {
    const slot = o.freeSlots(c.id)[0];
    if (slot !== undefined) return { location_id: c.id, slot };
  }
  return null;
}

/** Stored pallets of a SKU that are not allocated to an order or a task, oldest (lowest id) first. */
export function availablePallets(o: OpsDraft, sku: string): PalletState[] {
  return o.pallets.sorted().filter((p) => p.sku === sku && p.at.kind === "slot" && !p.order_id && !p.task_id);
}

/** Pallets of a location in a rack slot, sorted by slot. */
export function palletsInLocation(o: OpsDraft, locationId: string): PalletState[] {
  return o.pallets
    .values()
    .filter((p) => p.at.kind === "slot" && p.at.location_id === locationId)
    .sort((a, b) => (a.at.kind === "slot" && b.at.kind === "slot" ? a.at.slot - b.at.slot : 0));
}

/** Free rack slots across the whole facility. */
export function freeStorage(o: OpsDraft): number {
  return o.draft.config.locations.reduce((n, l) => n + o.freeSlots(l.id).length, 0);
}

/**
 * Inbound pallets that will still need a storage slot: on inbound trucks, being unloaded, or staged
 * without a put-away task (put-away tasks have already reserved their slot).
 */
export function inboundBacklog(o: OpsDraft): number {
  let n = 0;
  for (const p of o.pallets.values()) {
    if (p.order_id) continue;
    const task = p.task_id ? o.tasks.get(p.task_id) : undefined;
    if (p.at.kind === "truck" || (p.at.kind === "staging" && task?.type !== "putaway") || task?.type === "unload") n++;
  }
  return n;
}

/** Yard slots in use: trucks waiting, docking, or leaving without having docked. */
export function freeYardSlot(o: OpsDraft): number | null {
  const capacity = Math.max(2, o.graph.doorNode.size);
  const used = new Set(
    o.trucks
      .values()
      .filter((t) => t.status === "yard" || t.status === "docking" || (t.status === "departing" && t.dock_id === null))
      .map((t) => t.yard_slot),
  );
  for (let s = 0; s < capacity; s++) if (!used.has(s)) return s;
  return null;
}
