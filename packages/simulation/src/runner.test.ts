import { describe, expect, it } from "vitest";
import {
  createFoundationDemoConfig,
  createSnapshot,
  loadSnapshot,
  serializeSnapshot,
  SimulationRunner,
  stateHash,
  step,
} from "./index";

const config = createFoundationDemoConfig();

describe("SimulationRunner time control", () => {
  it("starts paused and pausing freezes simulation time", () => {
    const r = new SimulationRunner(config);
    expect(r.paused).toBe(true);
    expect(r.advance(10_000).ticks).toBe(0);
    expect(r.simulationTimeMs).toBe(0);

    r.resume();
    r.advance(1000);
    const t = r.simulationTimeMs;
    expect(t).toBe(1000);
    r.pause();
    for (let i = 0; i < 100; i++) r.advance(16.7);
    expect(r.simulationTimeMs).toBe(t);
  });

  it("uses a fixed step: tick count depends on total elapsed time, not on frame slicing", () => {
    const a = new SimulationRunner(config);
    const b = new SimulationRunner(config);
    a.resume();
    b.resume();
    a.advance(5000);
    for (let i = 0; i < 300; i++) b.advance(5000 / 300);
    expect(b.state.tick).toBe(a.state.tick);
    expect(stateHash(config, b.state)).toBe(stateHash(config, a.state));
  });

  it("scales simulated time by speed and validates the range", () => {
    const r = new SimulationRunner(config);
    r.resume();
    r.setSpeed(4);
    r.advance(1000);
    expect(r.simulationTimeMs).toBe(4000);
    expect(() => r.setSpeed(0)).toThrow(RangeError);
    expect(() => r.setSpeed(100)).toThrow(RangeError);
    expect(() => r.setSpeed(Number.NaN)).toThrow(RangeError);
  });

  it("caps ticks per advance and reports the dropped backlog", () => {
    const r = new SimulationRunner(config, { maxTicksPerAdvance: 10 });
    r.resume();
    const s = r.advance(60_000);
    expect(s.ticks).toBe(10);
    expect(s.droppedMs).toBeGreaterThan(0);
    expect(r.advance(0).ticks).toBe(0);
  });
});

describe("SimulationRunner commands and state protection", () => {
  it("rejects schema-invalid input at submit and logs applied commands with their tick", () => {
    const r = new SimulationRunner({ ...config, synthetic_workload: undefined });
    expect(r.submit({ command_id: "bad", type: "inventory.receive", payload: {} }).accepted).toBe(
      false,
    );
    expect(
      r.submit({
        command_id: "ok",
        type: "inventory.receive",
        payload: { location_id: "loc-00-001", sku: "sku-std-pallet", quantity: 2 },
      }).accepted,
    ).toBe(true);
    const res = r.stepOnce();
    expect(res.events).toHaveLength(1);
    expect(r.commandLog).toEqual([
      { tick: 1, command: expect.objectContaining({ command_id: "ok" }) },
    ]);
  });

  it("publishes deeply frozen state so rendering code cannot secretly mutate it", () => {
    const r = new SimulationRunner(config);
    r.resume();
    r.advance(3000);
    const s = r.state;
    expect(() => {
      (s as { tick: number }).tick = 999;
    }).toThrow(TypeError);
    const loc = Object.keys(s.inventory)[0]!;
    expect(() => {
      (s.inventory[loc] as Record<string, number>)["sku-std-pallet"] = 1e6;
    }).toThrow(TypeError);
  });

  it("notifies subscribers once per tick", () => {
    const r = new SimulationRunner(config);
    let calls = 0;
    const off = r.subscribe(() => calls++);
    r.resume();
    r.advance(1000);
    off();
    r.advance(1000);
    expect(calls).toBe(10);
  });
});

describe("snapshots", () => {
  it("round-trip through JSON and resume the identical trajectory", () => {
    const straight = new SimulationRunner(config);
    for (let i = 0; i < 800; i++) straight.stepOnce();

    const first = new SimulationRunner(config);
    for (let i = 0; i < 300; i++) first.stepOnce();
    const restored = SimulationRunner.fromSnapshot(
      loadSnapshot(serializeSnapshot(first.snapshot())),
    );
    for (let i = 0; i < 500; i++) restored.stepOnce();

    expect(stateHash(config, restored.state)).toBe(stateHash(config, straight.state));
  });

  it("rejects corrupt, tampered or unsupported snapshots", () => {
    const r = new SimulationRunner(config);
    for (let i = 0; i < 200; i++) r.stepOnce();
    const snap = r.snapshot();

    const tampered = JSON.parse(serializeSnapshot(snap));
    tampered.state.tick += 1;
    expect(() => loadSnapshot(JSON.stringify(tampered))).toThrow(/hash mismatch/);

    expect(() => loadSnapshot(JSON.stringify({ ...snap, snapshot_version: 99 }))).toThrow(
      /unsupported snapshot_version/,
    );

    const loc = config.locations[0]!.id;
    const overfull = { ...snap.state, inventory: { [loc]: { "sku-std-pallet": 999 } } };
    const forged = createSnapshot(config, overfull);
    expect(() => loadSnapshot(serializeSnapshot(forged))).toThrow(/violates invariants/);
  });

  it("produce the same state as direct stepping", () => {
    const r = new SimulationRunner(config);
    let s = r.state;
    for (let i = 0; i < 100; i++) {
      r.stepOnce();
      s = step(config, s).state;
    }
    expect(stateHash(config, r.state)).toBe(stateHash(config, s));
  });
});
