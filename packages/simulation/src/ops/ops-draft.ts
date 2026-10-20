import type { PalletPosition } from "@warehouse-one/contracts";
import type { TickDraft } from "../draft";
import {
  formatId,
  positionKey,
  type DockState,
  type EquipmentState,
  type OperationsState,
  type OrderState,
  type PalletState,
  type TaskState,
  type TruckState,
} from "./model";
import type { NavGraph } from "./nav";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Copy-on-write record: the base object is copied on the first write in a tick. */
class Cow<V> {
  private copied = false;
  constructor(private data: Readonly<Record<string, V>>) {}
  get(id: string): V | undefined {
    return this.data[id];
  }
  has(id: string): boolean {
    return id in this.data;
  }
  values(): V[] {
    return Object.values(this.data);
  }
  /** Values sorted by id: the only iteration order systems may rely on. */
  sorted(): V[] {
    return Object.keys(this.data)
      .sort()
      .map((k) => this.data[k] as V);
  }
  set(id: string, value: V): void {
    this.write()[id] = value;
  }
  delete(id: string): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- draft copy owned by this tick
    delete this.write()[id];
  }
  snapshot(): Readonly<Record<string, V>> {
    return this.data;
  }
  private write(): Record<string, V> {
    if (!this.copied) {
      this.data = { ...this.data };
      this.copied = true;
    }
    return this.data as Record<string, V>;
  }
}

/**
 * Working copy of the operational state for one tick. All pallet movement goes through
 * `placePallet` / `removePallet`, which keep the occupancy index and the Phase 0 inventory
 * projection (`state.inventory`) consistent in one place.
 */
export class OpsDraft {
  readonly pallets: Cow<PalletState>;
  readonly equipment: Cow<EquipmentState>;
  readonly tasks: Cow<TaskState>;
  readonly trucks: Cow<TruckState>;
  readonly orders: Cow<OrderState>;
  readonly docks: Cow<DockState>;
  readonly reservations: Cow<string>;
  private nextId: Mutable<OperationsState["next_id"]>;
  private occupancy: Map<string, string> | null = null;

  constructor(
    readonly draft: TickDraft,
    readonly graph: NavGraph,
    base: OperationsState,
  ) {
    this.pallets = new Cow(base.pallets);
    this.equipment = new Cow(base.equipment);
    this.tasks = new Cow(base.tasks);
    this.trucks = new Cow(base.trucks);
    this.orders = new Cow(base.orders);
    this.docks = new Cow(base.docks);
    this.reservations = new Cow(base.reservations);
    this.nextId = { ...base.next_id };
  }

  get tick(): number {
    return this.draft.tick;
  }

  newId(kind: "pallet" | "task" | "truck" | "order"): string {
    this.nextId[kind] += 1;
    const prefix = { pallet: "plt", task: "tsk", truck: "trk", order: "ord" } as const;
    return formatId(prefix[kind], this.nextId[kind]);
  }

  /** positionKey -> pallet id for every pallet. Built lazily, then maintained incrementally. */
  private index(): Map<string, string> {
    if (!this.occupancy) {
      this.occupancy = new Map();
      for (const p of this.pallets.values()) this.occupancy.set(positionKey(p.at), p.id);
    }
    return this.occupancy;
  }

  occupant(p: PalletPosition): string | undefined {
    return this.index().get(positionKey(p));
  }

  /** Free = not occupied and not reserved by a task. */
  isFree(p: PalletPosition): boolean {
    const key = positionKey(p);
    return !this.index().has(key) && !this.reservations.has(key);
  }

  /** Create a new pallet or move an existing one; updates occupancy and the inventory projection. */
  placePallet(pallet: PalletState, previous?: PalletState): void {
    const idx = this.index();
    if (previous) {
      idx.delete(positionKey(previous.at));
      if (previous.at.kind === "slot") this.adjustSlotCount(previous.at.location_id, previous.sku, -1);
    }
    const key = positionKey(pallet.at);
    const holder = idx.get(key);
    if (holder !== undefined && holder !== pallet.id) {
      throw new Error(`invariant violated: ${key} already holds ${holder}`);
    }
    idx.set(key, pallet.id);
    if (pallet.at.kind === "slot") this.adjustSlotCount(pallet.at.location_id, pallet.sku, +1);
    this.pallets.set(pallet.id, pallet);
  }

  removePallet(pallet: PalletState): void {
    this.index().delete(positionKey(pallet.at));
    if (pallet.at.kind === "slot") this.adjustSlotCount(pallet.at.location_id, pallet.sku, -1);
    this.pallets.delete(pallet.id);
  }

  /** Update a pallet's allocation fields without moving it. */
  updatePallet(id: string, patch: Partial<Pick<PalletState, "order_id" | "task_id">>): void {
    const p = this.pallets.get(id);
    if (!p) throw new Error(`invariant violated: unknown pallet ${id}`);
    this.pallets.set(id, { ...p, ...patch });
  }

  private adjustSlotCount(locationId: string, sku: string, delta: number): void {
    this.draft.setQuantity(locationId, sku, this.draft.quantity(locationId, sku) + delta);
  }

  /** Free rack slots of a location in ascending slot order (bottom-up, left to right). */
  freeSlots(locationId: string): number[] {
    const loc = this.draft.locationIndex.get(locationId);
    if (!loc) return [];
    const out: number[] = [];
    for (let s = 0; s < loc.capacity; s++) {
      if (this.isFree({ kind: "slot", location_id: locationId, slot: s })) out.push(s);
    }
    return out;
  }

  commit(): OperationsState {
    return {
      pallets: this.pallets.snapshot(),
      equipment: this.equipment.snapshot(),
      tasks: this.tasks.snapshot(),
      trucks: this.trucks.snapshot(),
      orders: this.orders.snapshot(),
      docks: this.docks.snapshot(),
      reservations: this.reservations.snapshot(),
      next_id: this.nextId,
    };
  }
}
