import type { TickDraft } from "../draft";
import { move, receive } from "../handlers";

/**
 * Seeded synthetic workload for demos and benchmarks (clearly not a business process).
 * It goes through the same handlers as user commands, so every invariant still applies.
 * Random draws happen unconditionally in a fixed order so the RNG stream is stable even when an
 * operation is skipped (e.g. a full location).
 */
export function syntheticWorkloadSystem(d: TickDraft): void {
  const cfg = d.config.synthetic_workload;
  if (!cfg) return;
  const locations = d.config.locations;
  const skus = d.config.skus;
  if (locations.length < 2 || skus.length === 0) return;

  const trace = {
    correlation_id: `sys-workload-t${d.tick}`,
    causation_id: "system:synthetic-workload",
  };

  const inboundRoll = d.random();
  const inLoc = locations[d.randomInt(0, locations.length - 1)];
  const inSku = skus[d.randomInt(0, skus.length - 1)];
  const inQty = d.randomInt(1, cfg.max_quantity);
  if (inboundRoll < cfg.inbound_probability && inLoc && inSku) {
    const free = inLoc.capacity - d.locationTotal(inLoc.id);
    const quantity = Math.min(inQty, free);
    if (quantity > 0) receive(d, { location_id: inLoc.id, sku: inSku.id, quantity }, trace);
  }

  const moveRoll = d.random();
  const from = locations[d.randomInt(0, locations.length - 1)];
  const to = locations[d.randomInt(0, locations.length - 1)];
  if (moveRoll < cfg.move_probability && from && to && from.id !== to.id) {
    // Move the first SKU (in config order) that the source holds and the target can accept.
    for (const sku of skus) {
      const available = d.quantity(from.id, sku.id);
      const free = to.capacity - d.locationTotal(to.id);
      const quantity = Math.min(available, free, cfg.max_quantity);
      if (quantity > 0) {
        move(d, { from_location_id: from.id, to_location_id: to.id, sku: sku.id, quantity }, trace);
        break;
      }
    }
  }
}
