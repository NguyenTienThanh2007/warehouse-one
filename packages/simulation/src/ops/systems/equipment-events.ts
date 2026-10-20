import type { OpsDraft } from "../ops-draft";
import type { EquipmentState } from "../model";

/** Store a vehicle's new state and emit `equipment.status_changed` when its status changes. */
export function setEquipment(o: OpsDraft, prev: EquipmentState, next: EquipmentState): void {
  const changed = prev.status !== next.status;
  o.equipment.set(next.id, changed ? { ...next, status_since_tick: o.tick } : next);
  if (!changed) return;
  const task = next.task_id ? o.tasks.get(next.task_id) : undefined;
  o.draft.emit(
    "equipment.status_changed",
    next.id,
    {
      equipment_id: next.id,
      from: prev.status,
      to: next.status,
      node_id: next.node,
      task_id: next.task_id,
      battery_permille: next.battery_permille,
    },
    {
      correlation_id: task?.correlation_id ?? `sys-ops-t${o.tick}`,
      causation_id: "system:equipment",
    },
  );
}
