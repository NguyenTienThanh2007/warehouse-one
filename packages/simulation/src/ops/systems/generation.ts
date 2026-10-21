import type { OpsDraft } from "../ops-draft";
import { STAGING_LANE_CAPACITY, type PalletState } from "../model";
import { createTask, nearestFreeSlot, systemTrace } from "../tasks";

/** Free staging positions of a dock, nearest the door first. */
function freeLanePositions(o: OpsDraft, dockId: string): number[] {
  const out: number[] = [];
  for (let k = 0; k < STAGING_LANE_CAPACITY; k++)
    if (o.isFree({ kind: "staging", dock_id: dockId, position: k })) out.push(k);
  return out;
}

const byId = (a: PalletState, b: PalletState) => a.id.localeCompare(b.id);

/**
 * Turns operational state into work. Every rule is deterministic (ids and positions in ascending
 * order) and each task reserves its destination, so two tasks can never target the same place.
 *
 * 1. Unload: a docked inbound truck's pallets → free staging positions at its dock.
 * 2. Put away: unallocated staged pallets → nearest free rack slot (by travel distance).
 * 3. Pick: an in-progress order's pallets → free staging positions at its truck's dock.
 * 4. Load: staged order pallets → free trailer positions of the docked outbound truck.
 */
export function taskGenerationSystem(o: OpsDraft): void {
  const trucks = o.trucks.sorted();

  for (const t of trucks.filter(
    (x) => x.direction === "inbound" && x.status === "docked" && x.dock_id,
  )) {
    const dock = t.dock_id as string;
    const lane = freeLanePositions(o, dock);
    const cargo = o.pallets
      .values()
      .filter((p) => p.at.kind === "truck" && p.at.truck_id === t.id && !p.task_id)
      .sort(byId);
    for (const pallet of cargo) {
      const position = lane.shift();
      if (position === undefined) break;
      createTask(
        o,
        "unload",
        pallet,
        { kind: "staging", dock_id: dock, position },
        { order_id: null, truck_id: t.id },
        { correlation_id: t.correlation_id, causation_id: "system:tasks" },
      );
    }
  }

  const staged = o.pallets
    .values()
    .filter((p) => p.at.kind === "staging" && !p.order_id && !p.task_id)
    .sort(byId);
  for (const pallet of staged) {
    if (pallet.at.kind !== "staging") continue;
    const from = o.graph.laneNodes.get(pallet.at.dock_id)?.[pallet.at.position];
    const slot = from ? nearestFreeSlot(o, from) : null;
    if (!slot) break; // storage full: pallets wait in staging (visible as blocked work)
    createTask(
      o,
      "putaway",
      pallet,
      { kind: "slot", ...slot },
      { order_id: null, truck_id: null },
      systemTrace(o, "tasks"),
    );
  }

  for (const order of o.orders.sorted().filter((x) => x.status === "in_progress")) {
    const truck = o.trucks.get(order.truck_id);
    if (!truck?.dock_id) continue;
    const lane = freeLanePositions(o, truck.dock_id);
    const trace = { correlation_id: order.correlation_id, causation_id: "system:tasks" };
    for (const id of [...order.pallet_ids].sort()) {
      const pallet = o.pallets.get(id);
      if (!pallet || pallet.task_id || pallet.at.kind !== "slot") continue;
      const position = lane.shift();
      if (position === undefined) break;
      createTask(
        o,
        "pick",
        pallet,
        { kind: "staging", dock_id: truck.dock_id, position },
        { order_id: order.id, truck_id: truck.id },
        trace,
      );
    }
    if (truck.status !== "docked") continue;
    for (const id of [...order.pallet_ids].sort()) {
      const pallet = o.pallets.get(id);
      if (
        !pallet ||
        pallet.task_id ||
        pallet.at.kind !== "staging" ||
        pallet.at.dock_id !== truck.dock_id
      )
        continue;
      let position = 0;
      while (!o.isFree({ kind: "truck", truck_id: truck.id, position })) position++;
      createTask(
        o,
        "load",
        pallet,
        { kind: "truck", truck_id: truck.id, position },
        { order_id: order.id, truck_id: truck.id },
        trace,
      );
    }
  }
}
