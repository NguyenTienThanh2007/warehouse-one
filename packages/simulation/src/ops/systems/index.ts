import type { TickDraft } from "../../draft";
import { dispatchSystem } from "./dispatch";
import { equipmentSystem } from "./equipment";
import { taskGenerationSystem } from "./generation";
import { truckSystem } from "./trucks";
import { operationsWorkloadSystem } from "./workload";

/**
 * Operational systems, run every tick after commands, in this fixed order:
 * workload → trucks/docks → task generation → dispatch → equipment (move, handle, charge).
 */
export function operationsSystem(d: TickDraft): void {
  const o = d.ops;
  if (!o) return;
  operationsWorkloadSystem(o);
  truckSystem(o);
  taskGenerationSystem(o);
  dispatchSystem(o);
  equipmentSystem(o);
}
