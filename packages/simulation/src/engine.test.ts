import { DomainEvent, type SimulationCommand } from "@warehouse-one/contracts";
import { describe, expect, it } from "vitest";
import {
  checkInvariants,
  createFoundationDemoConfig,
  createInitialState,
  replay,
  step,
  totalsBySku,
  validateConfig,
  type LoggedCommand,
  type SimulationConfig,
  type SimulationState,
} from "./index";
import { nextInt, seedRng, type RngState } from "./rng";
import { stateHash } from "./snapshot";

const base = createFoundationDemoConfig();
/** Same layout, no synthetic workload: only explicit commands change state. */
const quiet: SimulationConfig = { ...base, synthetic_workload: undefined };

const recv = (id: string, location_id: string, sku: string, quantity: number): SimulationCommand => ({
  command_id: id,
  type: "inventory.receive",
  payload: { location_id, sku, quantity },
});
const mv = (id: string, from: string, to: string, sku: string, quantity: number): SimulationCommand => ({
  command_id: id,
  type: "inventory.move",
  payload: { from_location_id: from, to_location_id: to, sku, quantity },
});

function run(config: SimulationConfig, ticks: number) {
  let state = createInitialState(config);
  const events: DomainEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const r = step(config, state);
    events.push(...r.events);
    state = r.state;
  }
  return { state, events };
}

describe("configuration", () => {
  it("accepts the demo config", () => {
    expect(validateConfig(base)).toEqual([]);
  });
  it("rejects duplicate ids, bad capacity and bad epoch", () => {
    const loc = base.locations[0]!;
    const bad: SimulationConfig = {
      ...base,
      epoch: "2026-01-05 06:00",
      locations: [loc, { ...loc }, { ...loc, id: "loc-x", capacity: 0 }],
    };
    expect(validateConfig(bad).length).toBeGreaterThanOrEqual(3);
    expect(() => createInitialState(bad)).toThrow(/invalid simulation config/);
  });
});

describe("determinism", () => {
  it("same seed and inputs produce identical state and events", () => {
    const a = run(base, 1500);
    const b = run(base, 1500);
    expect(a.events.length).toBeGreaterThan(100);
    expect(stateHash(base, a.state)).toBe(stateHash(base, b.state));
    expect(a.events).toEqual(b.events);
  });

  it("different seeds diverge", () => {
    const other = { ...base, seed: "another-seed" };
    expect(stateHash(base, run(base, 300).state)).not.toBe(stateHash(other, run(other, 300).state));
  });

  it("replaying the command log reproduces the live run exactly", () => {
    let state = createInitialState(base);
    const log: LoggedCommand[] = [];
    const liveEvents: DomainEvent[] = [];
    for (let t = 1; t <= 400; t++) {
      const cmds: SimulationCommand[] = t % 37 === 0 ? [recv(`c${t}`, "loc-00-003", "sku-bulk-bags", 2)] : [];
      for (const command of cmds) log.push({ tick: t, command });
      const r = step(base, state, cmds);
      liveEvents.push(...r.events);
      state = r.state;
    }
    const replayEvents: DomainEvent[] = [];
    const replayed = replay(base, log, 400, (r) => replayEvents.push(...r.events));
    expect(stateHash(base, replayed)).toBe(stateHash(base, state));
    expect(replayEvents).toEqual(liveEvents);
  });

  it("never mutates its input state", () => {
    const deepFreeze = (o: unknown): void => {
      if (o && typeof o === "object") {
        Object.freeze(o);
        Object.values(o).forEach(deepFreeze);
      }
    };
    let state: SimulationState = run(base, 50).state;
    for (let i = 0; i < 200; i++) {
      deepFreeze(state);
      const before = stateHash(base, state);
      const next = step(base, state, [recv(`f${i}`, "loc-01-005", "sku-std-pallet", 1)]).state;
      expect(stateHash(base, state)).toBe(before);
      state = next;
    }
  });
});

describe("command validation and inventory invariants", () => {
  it("rejects schema-invalid commands safely without changing state", () => {
    const s0 = createInitialState(quiet);
    const r = step(quiet, s0, [
      { command_id: "x1", type: "inventory.receive", payload: { location_id: "loc-00-001", sku: "sku-std-pallet", quantity: -5 } },
      { nonsense: true },
      null,
    ]);
    expect(r.rejections.map((x) => x.code)).toEqual(["INVALID_COMMAND", "INVALID_COMMAND", "INVALID_COMMAND"]);
    expect(r.events).toEqual([]);
    expect(r.state.inventory).toEqual({});
  });

  it("rejects unknown references, overdraws and capacity overflow", () => {
    const s0 = createInitialState(quiet);
    const r = step(quiet, s0, [
      recv("a", "loc-zz-999", "sku-std-pallet", 1),
      recv("b", "loc-00-001", "sku-unknown", 1),
      recv("c", "loc-00-001", "sku-std-pallet", 9),
      mv("d", "loc-00-001", "loc-00-002", "sku-std-pallet", 1),
      { command_id: "e", type: "inventory.adjust", payload: { location_id: "loc-00-001", sku: "sku-std-pallet", delta: -1, reason: "damage" } },
    ]);
    expect(r.rejections.map((x) => x.code)).toEqual([
      "UNKNOWN_LOCATION",
      "UNKNOWN_SKU",
      "CAPACITY_EXCEEDED",
      "INSUFFICIENT_STOCK",
      "INSUFFICIENT_STOCK",
    ]);
    expect(r.state.inventory).toEqual({});
  });

  it("applies same-tick conflicting commands sequentially: the second overdraw is rejected", () => {
    const s1 = step(quiet, createInitialState(quiet), [recv("r", "loc-00-001", "sku-std-pallet", 5)]).state;
    const r = step(quiet, s1, [
      mv("m1", "loc-00-001", "loc-00-002", "sku-std-pallet", 4),
      mv("m2", "loc-00-001", "loc-00-003", "sku-std-pallet", 4),
    ]);
    expect(r.rejections).toEqual([expect.objectContaining({ command_id: "m2", code: "INSUFFICIENT_STOCK" })]);
    expect(totalsBySku(r.state)).toEqual({ "sku-std-pallet": 5 });
    expect(r.state.inventory["loc-00-001"]).toEqual({ "sku-std-pallet": 1 });
  });

  it("holds every invariant and conserves units under a long randomized command stream", () => {
    const config = base;
    let state = createInitialState(config);
    let rng: RngState = seedRng("fuzz");
    const pick = (n: number) => {
      const [v, next] = nextInt(rng, 0, n - 1);
      rng = next;
      return v;
    };
    const locIds = [...config.locations.map((l) => l.id), "loc-ghost-01"];
    const skuIds = [...config.skus.map((s) => s.id), "sku-ghost"];
    const expected: Record<string, number> = {};
    for (let t = 0; t < 3000; t++) {
      const cmds: unknown[] = [];
      for (let k = pick(4); k > 0; k--) {
        const loc = locIds[pick(locIds.length)]!;
        const sku = skuIds[pick(skuIds.length)]!;
        const qty = pick(12) - 1; // includes 0 (invalid) and values above capacity
        switch (pick(3)) {
          case 0:
            cmds.push(recv(`f${t}-${k}`, loc, sku, qty));
            break;
          case 1:
            cmds.push(mv(`f${t}-${k}`, loc, locIds[pick(locIds.length)]!, sku, qty));
            break;
          default:
            cmds.push({ command_id: `f${t}-${k}`, type: "inventory.adjust", payload: { location_id: loc, sku, delta: qty - 6, reason: "cycle_count" } });
        }
      }
      const r = step(config, state, cmds);
      for (const e of r.events) {
        const p = e.payload;
        if (e.event_type === "inventory.received") expected[e.aggregate_id] = (expected[e.aggregate_id] ?? 0) + (p as { quantity: number }).quantity;
        if (e.event_type === "inventory.adjusted") expected[e.aggregate_id] = (expected[e.aggregate_id] ?? 0) + (p as { delta: number }).delta;
      }
      expect(checkInvariants(config, r.state)).toEqual([]);
      state = r.state;
    }
    const nonZero = Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== 0));
    expect(totalsBySku(state)).toEqual(nonZero);
  });
});

describe("domain events", () => {
  const { events } = run(base, 2000);

  it("conform to the published contract", () => {
    for (const e of events) expect(DomainEvent.safeParse(e).success).toBe(true);
  });

  it("have a gap-free sequence, unique ids and per-aggregate monotonic versions", () => {
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    const last: Record<string, number> = {};
    for (const e of events) {
      expect(e.aggregate_version).toBe((last[e.aggregate_id] ?? 0) + 1);
      last[e.aggregate_id] = e.aggregate_version;
    }
  });

  it("derive occurred_at deterministically from epoch + simulation time", () => {
    for (const e of events) {
      expect(Date.parse(e.occurred_at)).toBe(Date.parse(base.epoch) + e.simulation_time_ms);
      expect(e.simulation_time_ms % base.tick_ms).toBe(0);
    }
  });
});
