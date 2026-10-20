import type { CargoLine, SimulationCommand } from "@warehouse-one/contracts";
import { applyOpsCommand } from "../commands";
import type { OpsDraft } from "../ops-draft";
import { availablePallets } from "../tasks";

/**
 * Seeded operational workload for demos and benchmarks. Work is issued through the same command
 * handlers as operator commands, so every rule applies; rejected work (e.g. a full yard) is simply
 * skipped. Intervals are staggered: inbound at 1/3, outbound at 2/3, relocations at 0.
 * Random draws happen only when work is due, from the in-state RNG, so runs replay exactly.
 */
export function operationsWorkloadSystem(o: OpsDraft): void {
  const w = o.draft.config.operations_workload;
  if (!w) return;
  const t = o.tick;
  const due = (interval: number, phase: number) => interval > 0 && t % interval === Math.floor((interval * phase) / 3);
  const skus = o.draft.config.skus.map((s) => s.id);
  const issue = (suffix: string, c: Omit<SimulationCommand, "command_id">) => {
    const command = { command_id: `wl-${suffix}-t${t}`, ...c } as SimulationCommand;
    applyOpsCommand(o, command, { correlation_id: command.command_id, causation_id: "system:workload" });
  };
  const lines = (counts: Map<string, number>): CargoLine[] => [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([sku, quantity]) => ({ sku, quantity }));

  if (due(w.inbound_interval_ticks, 1)) {
    const n = o.draft.randomInt(w.min_pallets, w.max_pallets);
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const sku = skus[o.draft.randomInt(0, skus.length - 1)] as string;
      counts.set(sku, (counts.get(sku) ?? 0) + 1);
    }
    issue("in", { type: "truck.schedule_inbound", payload: { cargo: lines(counts) } });
  }

  if (due(w.outbound_interval_ticks, 2)) {
    const n = o.draft.randomInt(w.min_pallets, w.max_pallets);
    const left = new Map(skus.map((s) => [s, availablePallets(o, s).length]));
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const stocked = skus.filter((s) => (left.get(s) ?? 0) > 0);
      if (stocked.length === 0) break;
      const sku = stocked[o.draft.randomInt(0, stocked.length - 1)] as string;
      left.set(sku, (left.get(sku) ?? 0) - 1);
      counts.set(sku, (counts.get(sku) ?? 0) + 1);
    }
    if (counts.size > 0) issue("out", { type: "order.create", payload: { lines: lines(counts) } });
  }

  if (due(w.relocate_interval_ticks, 0) && t > 0) {
    const candidates = o.pallets.sorted().filter((p) => p.at.kind === "slot" && !p.order_id && !p.task_id);
    if (candidates.length === 0) return;
    const pallet = candidates[o.draft.randomInt(0, candidates.length - 1)]!;
    const locations = o.draft.config.locations;
    const target = locations[o.draft.randomInt(0, locations.length - 1)]!;
    issue("mv", { type: "pallet.relocate", payload: { pallet_id: pallet.id, to_location_id: target.id } });
  }
}
