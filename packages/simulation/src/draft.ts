import {
  EVENT_PAYLOADS,
  type DomainEvent,
  type EventPayload,
  type EventType,
} from "@warehouse-one/contracts";
import { deterministicUuid } from "./hash";
import { nextFloat, nextInt, type RngState } from "./rng";
import type { SimulationConfig, SimulationState } from "./types";

/**
 * Copy-on-write working copy of the state for a single tick. Only `step()` creates drafts, so the
 * input state is never mutated and callers (including renderers) can hold references safely.
 */
export class TickDraft {
  readonly tick: number;
  private sequence: number;
  private rng: RngState;
  private readonly inventory: Record<string, Record<string, number>>;
  private readonly copiedLocations = new Set<string>();
  private readonly versions: Record<string, number>;
  readonly events: DomainEvent[] = [];
  readonly locationIndex: ReadonlyMap<string, SimulationConfig["locations"][number]>;
  readonly skuIds: ReadonlySet<string>;

  constructor(
    readonly config: SimulationConfig,
    base: SimulationState,
    indexes: {
      locations: ReadonlyMap<string, SimulationConfig["locations"][number]>;
      skus: ReadonlySet<string>;
    },
  ) {
    this.tick = base.tick + 1;
    this.sequence = base.sequence;
    this.rng = base.rng;
    this.inventory = { ...base.inventory } as Record<string, Record<string, number>>;
    this.versions = { ...base.aggregate_versions };
    this.locationIndex = indexes.locations;
    this.skuIds = indexes.skus;
  }

  get simulationTimeMs(): number {
    return this.tick * this.config.tick_ms;
  }

  random(): number {
    const [v, next] = nextFloat(this.rng);
    this.rng = next;
    return v;
  }

  randomInt(min: number, max: number): number {
    const [v, next] = nextInt(this.rng, min, max);
    this.rng = next;
    return v;
  }

  quantity(locationId: string, sku: string): number {
    return this.inventory[locationId]?.[sku] ?? 0;
  }

  locationTotal(locationId: string): number {
    let total = 0;
    for (const q of Object.values(this.inventory[locationId] ?? {})) total += q;
    return total;
  }

  setQuantity(locationId: string, sku: string, quantity: number): void {
    if (!Number.isInteger(quantity) || quantity < 0) {
      // Handlers validate first; reaching this is an engine bug, never a user error.
      throw new Error(`invariant violated: ${locationId}/${sku} quantity ${quantity}`);
    }
    if (!this.copiedLocations.has(locationId)) {
      this.inventory[locationId] = { ...this.inventory[locationId] };
      this.copiedLocations.add(locationId);
    }
    const row = this.inventory[locationId] as Record<string, number>;
    // Zero rows are removed so equal inventories always serialize (and hash) identically.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- row is a draft copy owned by this tick
    if (quantity === 0) delete row[sku];
    else row[sku] = quantity;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- inventory is a draft copy owned by this tick
    if (Object.keys(row).length === 0) delete this.inventory[locationId];
  }

  emit<T extends EventType>(
    eventType: T,
    aggregateId: string,
    payload: EventPayload<T>,
    ids: { correlation_id: string; causation_id: string },
  ): void {
    this.sequence += 1;
    const version = (this.versions[aggregateId] ?? 0) + 1;
    this.versions[aggregateId] = version;
    const occurred = new Date(Date.parse(this.config.epoch) + this.simulationTimeMs);
    this.events.push({
      event_id: deterministicUuid(this.config.simulation_id, this.sequence),
      event_type: eventType,
      schema_version: EVENT_PAYLOADS[eventType].version,
      aggregate_type: "inventory_item",
      aggregate_id: aggregateId,
      aggregate_version: version,
      simulation_id: this.config.simulation_id,
      sequence: this.sequence,
      occurred_at: occurred.toISOString(),
      simulation_time_ms: this.simulationTimeMs,
      correlation_id: ids.correlation_id,
      causation_id: ids.causation_id,
      payload,
    } as DomainEvent);
  }

  commit(): SimulationState {
    return {
      tick: this.tick,
      sequence: this.sequence,
      rng: this.rng,
      inventory: this.inventory,
      aggregate_versions: this.versions,
    };
  }
}
