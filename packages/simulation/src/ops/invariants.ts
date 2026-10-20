import { TRUCK_CAPACITY } from "@warehouse-one/contracts";
import type { SimulationConfig, SimulationState } from "../types";
import { formatId, positionKey, STAGING_LANE_CAPACITY } from "./model";
import { navGraph } from "./nav";

/**
 * Operational invariants (Phase 2). Returns violations; empty means healthy. Checked by
 * `checkInvariants`, so snapshots that violate them cannot be loaded.
 */
export function checkOpsInvariants(config: SimulationConfig, state: SimulationState): string[] {
  const v: string[] = [];
  const ops = state.ops;
  if (!config.facility) {
    if (ops) v.push("operational state present without facility data");
    return v;
  }
  if (!ops) return ["facility config without operational state"];
  const g = navGraph(config);
  const locations = new Map(config.locations.map((l) => [l.id, l]));

  // Pallets: one valid position each, no shared positions.
  const holder = new Map<string, string>();
  const projection: Record<string, Record<string, number>> = {};
  const truckLoad = new Map<string, number>();
  for (const p of Object.values(ops.pallets)) {
    const key = positionKey(p.at);
    const other = holder.get(key);
    if (other) v.push(`pallets ${other} and ${p.id} share position ${key}`);
    holder.set(key, p.id);
    switch (p.at.kind) {
      case "slot": {
        const loc = locations.get(p.at.location_id);
        if (!loc) v.push(`pallet ${p.id} in unknown location ${p.at.location_id}`);
        else if (p.at.slot >= loc.capacity) v.push(`pallet ${p.id} in slot ${p.at.slot} beyond capacity ${loc.capacity}`);
        const row = (projection[p.at.location_id] ??= {});
        row[p.sku] = (row[p.sku] ?? 0) + 1;
        break;
      }
      case "staging":
        if (!(p.at.dock_id in ops.docks)) v.push(`pallet ${p.id} staged at unknown dock ${p.at.dock_id}`);
        if (p.at.position >= STAGING_LANE_CAPACITY) v.push(`pallet ${p.id} at staging position ${p.at.position} beyond lane capacity`);
        break;
      case "equipment":
        if (ops.equipment[p.at.equipment_id]?.carrying !== p.id) v.push(`pallet ${p.id} is on ${p.at.equipment_id}, which is not carrying it`);
        break;
      case "truck": {
        const truck = ops.trucks[p.at.truck_id];
        if (!truck) v.push(`pallet ${p.id} on unknown truck ${p.at.truck_id}`);
        else if (truck.direction === "outbound" ? p.order_id !== truck.order_id : p.order_id !== null) {
          v.push(`pallet ${p.id} on ${truck.direction} truck ${truck.id} has the wrong order allocation`);
        }
        if (p.at.position >= TRUCK_CAPACITY) v.push(`pallet ${p.id} at trailer position ${p.at.position} beyond capacity`);
        truckLoad.set(p.at.truck_id, (truckLoad.get(p.at.truck_id) ?? 0) + 1);
        break;
      }
    }
    if (p.task_id && ops.tasks[p.task_id]?.pallet_id !== p.id) v.push(`pallet ${p.id} references task ${p.task_id}, which does not move it`);
    if (p.order_id && !ops.orders[p.order_id]?.pallet_ids.includes(p.id)) v.push(`pallet ${p.id} references order ${p.order_id}, which does not list it`);
  }

  // The Phase 0 inventory table is exactly the projection of slotted pallets.
  const keys = new Set([...Object.keys(projection), ...Object.keys(state.inventory)]);
  for (const loc of keys) {
    const a = projection[loc] ?? {};
    const b = state.inventory[loc] ?? {};
    for (const sku of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if ((a[sku] ?? 0) !== (b[sku] ?? 0)) v.push(`inventory ${loc}/${sku} is ${b[sku] ?? 0} but ${a[sku] ?? 0} pallets are slotted there`);
    }
  }

  // Tasks and reservations.
  for (const t of Object.values(ops.tasks)) {
    const pallet = ops.pallets[t.pallet_id];
    if (pallet?.task_id !== t.id) v.push(`task ${t.id} moves ${t.pallet_id}, which does not reference it`);
    // A reservation lasts until the pallet is set down at the destination (mid-way through the drop).
    const delivered = pallet !== undefined && positionKey(pallet.at) === positionKey(t.to);
    if (!delivered && ops.reservations[positionKey(t.to)] !== t.id) v.push(`task ${t.id} has not reserved its destination ${positionKey(t.to)}`);
    if (delivered && t.status !== "dropping") v.push(`task ${t.id} delivered its pallet but is ${t.status}`);
    const active = t.status !== "pending";
    if (active !== (t.equipment_id !== null)) v.push(`task ${t.id} is ${t.status} but equipment is ${t.equipment_id ?? "none"}`);
    if (t.equipment_id && ops.equipment[t.equipment_id]?.task_id !== t.id) v.push(`task ${t.id} assigned to ${t.equipment_id}, which is not working on it`);
  }
  for (const [key, taskId] of Object.entries(ops.reservations)) {
    const t = ops.tasks[taskId];
    if (!t || positionKey(t.to) !== key) v.push(`reservation ${key} references task ${taskId}, which does not target it`);
    if (holder.has(key)) v.push(`reserved destination ${key} is occupied by ${holder.get(key)}`);
  }

  // Equipment.
  for (const e of Object.values(ops.equipment)) {
    if (!g.nodes.has(e.node)) v.push(`equipment ${e.id} at unknown node ${e.node}`);
    let prev = e.node;
    for (const n of e.route) {
      if (!g.adjacency.get(prev)?.some((x) => x.to === n)) v.push(`equipment ${e.id} route step ${prev}→${n} is not an edge`);
      prev = n;
    }
    const next = e.route[0];
    const len = next ? g.adjacency.get(e.node)?.find((x) => x.to === next)?.length : 0;
    if (e.progress_mm < 0 || (len !== undefined && e.progress_mm >= Math.max(1, len))) v.push(`equipment ${e.id} progress ${e.progress_mm} outside its edge`);
    if (!next && e.progress_mm !== 0) v.push(`equipment ${e.id} has progress without a route`);
    if (e.battery_permille < 0 || e.battery_permille > 1000) v.push(`equipment ${e.id} battery ${e.battery_permille} out of range`);
    if (e.carrying && ops.pallets[e.carrying]?.at.kind !== "equipment") v.push(`equipment ${e.id} carries ${e.carrying}, which is not on it`);
    if ((e.status === "handling") !== (e.handling !== null)) v.push(`equipment ${e.id} handling state does not match status ${e.status}`);
    if (e.task_id && ops.tasks[e.task_id]?.equipment_id !== e.id) v.push(`equipment ${e.id} works on ${e.task_id}, which is not assigned to it`);
    for (const n of [e.node, ...(e.progress_mm > 0 && e.route[0] ? [e.route[0]] : [])]) {
      const zone = g.nodes.get(n)?.zone;
      if (zone && e.zone_claim !== zone) v.push(`equipment ${e.id} is inside zone ${zone} without claiming it`);
    }
  }
  const claims = new Map<string, string>();
  for (const e of Object.values(ops.equipment)) {
    if (!e.zone_claim) continue;
    const other = claims.get(e.zone_claim);
    if (other) v.push(`zone ${e.zone_claim} claimed by both ${other} and ${e.id}`);
    claims.set(e.zone_claim, e.id);
  }
  const occupied = new Map<string, string>();
  for (const e of Object.values(ops.equipment)) {
    for (const n of [e.node, ...(e.progress_mm > 0 && e.route[0] ? [e.route[0]] : [])]) {
      const other = occupied.get(n);
      if (other && other !== e.id) v.push(`node ${n} held by both ${other} and ${e.id}`);
      occupied.set(n, e.id);
    }
  }

  // Docks and trucks: one truck per dock, one dock per truck.
  for (const [dockId, d] of Object.entries(ops.docks)) {
    if (d.truck_id && ops.trucks[d.truck_id]?.dock_id !== dockId) v.push(`dock ${dockId} holds ${d.truck_id}, which is not at it`);
  }
  for (const t of Object.values(ops.trucks)) {
    const atDock = t.status === "docking" || t.status === "docked" || (t.status === "departing" && t.dock_id !== null);
    if (atDock !== (t.dock_id !== null)) v.push(`truck ${t.id} is ${t.status} with dock ${t.dock_id ?? "none"}`);
    if (t.dock_id && ops.docks[t.dock_id]?.truck_id !== t.id) v.push(`truck ${t.id} claims dock ${t.dock_id}, which holds ${ops.docks[t.dock_id]?.truck_id ?? "nothing"}`);
    if (t.direction === "outbound" && !t.order_id) v.push(`outbound truck ${t.id} has no order`);
    if (t.direction === "outbound" && t.order_id && !ops.orders[t.order_id] && t.status !== "departing") v.push(`truck ${t.id} serves missing order ${t.order_id}`);
    if ((truckLoad.get(t.id) ?? 0) > TRUCK_CAPACITY) v.push(`truck ${t.id} over capacity`);
  }
  for (const o of Object.values(ops.orders)) {
    if (ops.trucks[o.truck_id]?.order_id !== o.id) v.push(`order ${o.id} truck ${o.truck_id} does not serve it`);
    for (const id of o.pallet_ids) if (ops.pallets[id]?.order_id !== o.id) v.push(`order ${o.id} lists ${id}, which is not allocated to it`);
    const wanted = o.lines.reduce((n, l) => n + l.quantity, 0);
    if (o.pallet_ids.length !== wanted) v.push(`order ${o.id} allocates ${o.pallet_ids.length} pallets for ${wanted} ordered`);
  }

  // Identifiers are issued from the counters, never reused.
  const check = (prefix: "plt" | "tsk" | "trk" | "ord", ids: string[], next: number) => {
    for (const id of ids) if (id > formatId(prefix, next)) v.push(`${id} is beyond the id counter ${next}`);
  };
  check("plt", Object.keys(ops.pallets), ops.next_id.pallet);
  check("tsk", Object.keys(ops.tasks), ops.next_id.task);
  check("trk", Object.keys(ops.trucks), ops.next_id.truck);
  check("ord", Object.keys(ops.orders), ops.next_id.order);
  return v;
}
