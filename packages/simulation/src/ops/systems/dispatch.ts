import type { OpsDraft } from "../ops-draft";
import { BATTERY_NEEDS_CHARGE, canPerform, type EquipmentState } from "../model";
import { findPath, pathLength, shortestPaths } from "../nav";
import { nodeFor } from "../tasks";
import { setEquipment } from "./equipment-events";

/**
 * Available: no task, enough charge, and either idle, opportunity-charging at home, or returning
 * home and currently standing on a node (a vehicle mid-edge is picked up on its next node).
 */
export function isAvailable(e: EquipmentState): boolean {
  if (e.task_id || e.battery_permille < BATTERY_NEEDS_CHARGE) return false;
  if (e.status === "idle") return true;
  if (e.status === "charging") return e.purpose !== "charge";
  return e.status === "travelling" && e.purpose === "park" && e.progress_mm === 0;
}

/**
 * Assigns pending tasks in creation order to the nearest available capable vehicle by travel
 * distance (ties: lower equipment id). Reach trucks never load or unload trailers.
 */
export function dispatchSystem(o: OpsDraft): void {
  const pending = o.tasks.sorted().filter((t) => t.status === "pending");
  if (pending.length === 0) return;
  // A dock path is a single-lane dead end: run at most one task touching it at a time, so no
  // vehicle queues on the front aisle waiting for a busy dock.
  const zoneOf = (node: string | null) => (node ? (o.graph.nodes.get(node)?.zone ?? null) : null);
  const busy = new Set<string>();
  for (const t of o.tasks.values()) {
    if (t.status === "pending") continue;
    for (const z of [zoneOf(nodeFor(o, t.from)), zoneOf(nodeFor(o, t.to))]) if (z) busy.add(z);
  }
  const distances = new Map<string, ReadonlyMap<string, number>>();
  const distanceFrom = (node: string) => {
    let d = distances.get(node);
    if (!d) {
      d = shortestPaths(o.graph, node).distance;
      distances.set(node, d);
    }
    return d;
  };
  for (const task of pending) {
    const free = o.equipment
      .sorted()
      .filter((e) => isAvailable(e) && canPerform(e.kind, task.type));
    if (free.length === 0) continue;
    const pickup = nodeFor(o, task.from);
    if (!pickup) continue;
    // Work touching a dock path waits until that dock's current task is done (no queueing outside).
    const zone = zoneOf(pickup);
    const dropZone = zoneOf(nodeFor(o, task.to));
    if ((zone && busy.has(zone)) || (dropZone && busy.has(dropZone))) continue;
    let best: EquipmentState | null = null;
    let bestD = Infinity;
    for (const e of free) {
      // Directed graph: distance from the vehicle to the pick-up point.
      const d = distanceFrom(e.node).get(pickup) ?? Infinity;
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    }
    if (!best || bestD === Infinity) continue;
    const route = findPath(o.graph, best.node, pickup) ?? [];
    for (const z of [zone, dropZone]) if (z) busy.add(z);
    o.tasks.set(task.id, { ...task, status: "assigned", equipment_id: best.id });
    setEquipment(o, best, {
      ...best,
      status: "travelling",
      purpose: "task",
      task_id: task.id,
      route,
      progress_mm: 0,
      wait_ticks: 0,
      blocked_by: null,
    });
    o.draft.emit(
      "task.assigned",
      task.id,
      {
        task_id: task.id,
        equipment_id: best.id,
        route_length_mm: pathLength(o.graph, best.node, route),
      },
      { correlation_id: task.correlation_id, causation_id: "system:dispatch" },
    );
  }
}
