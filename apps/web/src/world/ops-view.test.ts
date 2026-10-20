import type { SimulationCommand } from "@warehouse-one/contracts";
import {
  createInitialState,
  createScenario,
  dockedTruckPose,
  equipmentPose,
  navGraph,
  palletWorld,
  SPEED_MM_PER_TICK,
  step,
  totalsBySku,
  truckPose,
  type SimulationConfig,
  type SimulationState,
} from "@warehouse-one/simulation";
import { describe, expect, it } from "vitest";
import {
  carriedPallets,
  freeStock,
  lerpAngle,
  lerpPose,
  opsSceneCounts,
  opsSummary,
  staticPalletCapacity,
  staticPallets,
  truckViews,
  vehicleViews,
} from "./ops-view";

const scenario = createScenario("showcase");
const config = scenario.config;
const g = navGraph(config);
const opening = step(config, createInitialState(config), scenario.openingCommands).state;

/** Run the showcase, returning every state (index = tick offset from the opening state). */
function run(ticks: number, from: SimulationState = opening, cfg: SimulationConfig = config) {
  const states = [from];
  let s = from;
  for (let i = 0; i < ticks; i++) {
    s = step(cfg, s, []).state;
    states.push(s);
  }
  return states;
}
const states = run(3000);
const latest = states[states.length - 1]!;

describe("interpolation", () => {
  it("lerps angles along the shorter arc", () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4);
    // -170° → 170° goes through 180°, not through 0°.
    const a = (-170 * Math.PI) / 180;
    const b = (170 * Math.PI) / 180;
    expect(Math.abs(Math.cos(lerpAngle(a, b, 0.5)) + 1)).toBeLessThan(1e-9);
  });

  it("returns the endpoints exactly and interpolates every numeric field", () => {
    const a = { x: 0, z: 0, yaw: 0, fork: 0.08 };
    const b = { x: 2, z: -1, yaw: 1, fork: 1.08 };
    expect(lerpPose(a, b, 0)).toEqual(a);
    expect(lerpPose(a, b, 1)).toBe(b);
    expect(lerpPose(a, b, 0.5)).toEqual({ x: 1, z: -0.5, yaw: 0.5, fork: 0.58 });
  });
});

describe("vehicles are drawn where the simulation has them", () => {
  it("at alpha = 1 every vehicle is exactly at its authoritative pose; at 0, at the previous one", () => {
    for (const i of [10, 500, 1500, 2999]) {
      const prev = states[i - 1]!.ops!;
      const curr = states[i]!.ops!;
      const now = vehicleViews(config, prev, curr, 1);
      const before = vehicleViews(config, prev, curr, 0);
      expect(now.map((v) => v.id)).toEqual(Object.keys(curr.equipment).sort());
      for (const v of now) expect(v.pose).toEqual(equipmentPose(g, curr.equipment[v.id]!));
      for (const v of before) expect(v.pose).toEqual(equipmentPose(g, prev.equipment[v.id]!));
    }
  });

  it("never moves an interpolated vehicle faster than its simulated speed allows", () => {
    for (let i = 1; i < states.length; i += 7) {
      const prev = states[i - 1]!.ops!;
      const curr = states[i]!.ops!;
      const a = vehicleViews(config, prev, curr, 0.25);
      const b = vehicleViews(config, prev, curr, 0.75);
      a.forEach((v, k) => {
        const w = b[k]!;
        const moved = Math.abs(w.pose.x - v.pose.x) + Math.abs(w.pose.z - v.pose.z);
        // Half a tick of travel, at most (with float tolerance).
        expect(moved * 1000).toBeLessThanOrEqual(SPEED_MM_PER_TICK[v.kind].empty / 2 + 1);
      });
    }
  });

  it("raises the forks while handling (the pallet changes hands at full lift)", () => {
    const lifts = states.flatMap((s) =>
      vehicleViews(config, undefined, s.ops!, 1)
        .filter((v) => v.status === "handling")
        .map((v) => v.pose.fork),
    );
    expect(lifts.length).toBeGreaterThan(0);
    expect(Math.max(...lifts)).toBeGreaterThan(1);
  });
});

describe("pallets are drawn at their exact simulated positions", () => {
  it("draws one static pallet per pallet in a rack slot or staging lane, at palletWorld", () => {
    for (const s of [opening, states[1200]!, latest]) {
      const ops = s.ops!;
      const views = staticPallets(config, s);
      const expected = Object.values(ops.pallets).filter(
        (p) => p.at.kind === "slot" || p.at.kind === "staging",
      );
      expect(views.map((v) => v.id)).toEqual(expected.map((p) => p.id).sort());
      for (const v of views) {
        const w = palletWorld(config, s, ops.pallets[v.id]!.at)!;
        expect(v.position).toEqual([w.x, w.y, w.z]);
        expect(v.place).toBe(ops.pallets[v.id]!.at.kind);
      }
      // Rack pallets equal the inventory table: the KPI and the scene agree.
      const units = Object.values(totalsBySku(s)).reduce((a, b) => a + b, 0);
      expect(views.filter((v) => v.place === "slot")).toHaveLength(units);
      expect(views.length).toBeLessThanOrEqual(staticPalletCapacity(config));
    }
  });

  it("puts every carried pallet on the forks of the (interpolated) vehicle carrying it", () => {
    let checked = 0;
    for (let i = 1; i < states.length; i++) {
      const s = states[i]!;
      const vehicles = vehicleViews(config, states[i - 1]!.ops, s.ops!, 0.5);
      const carried = carriedPallets(config, s, vehicles);
      const onForks = Object.values(s.ops!.pallets).filter((p) => p.at.kind === "equipment");
      expect(carried).toHaveLength(onForks.length);
      for (const p of carried) {
        const v = vehicles.find((x) => x.carrying === p.id)!;
        expect(p.position[1]).toBeCloseTo(v.pose.fork - 0.04);
        // Within the fork reach in front of the vehicle.
        expect(Math.hypot(p.position[0] - v.pose.x, p.position[2] - v.pose.z)).toBeLessThan(1.2);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("hides pallets inside trailers and counts what is drawn", () => {
    const withTrucks = states.find((s) =>
      Object.values(s.ops!.pallets).some((p) => p.at.kind === "truck"),
    )!;
    expect(withTrucks).toBeDefined();
    const ops = withTrucks.ops!;
    const statics = staticPallets(config, withTrucks);
    const counts = opsSceneCounts(config, ops, statics);
    const summary = opsSummary(ops);
    expect(counts.pallets).toBe(
      summary.palletsByPlace.slot +
        summary.palletsByPlace.staging +
        summary.palletsByPlace.equipment,
    );
    expect(counts.pallets).toBe(Object.keys(ops.pallets).length - summary.palletsByPlace.truck);
    expect(counts.vehicles).toBe(4);
    expect(counts.trucks).toBe(Object.keys(ops.trucks).length);
    expect(Object.values(counts.palletsByArchetype).reduce((a, b) => a + b, 0)).toBe(
      counts.pallets,
    );
  });
});

describe("trucks and docks", () => {
  it("draws every truck on site at truckPose, and a docked truck with its rear at the dock", () => {
    let docked = 0;
    for (const s of states.filter((_, i) => i % 50 === 0)) {
      const ops = s.ops!;
      const views = truckViews(config, undefined, ops, 1);
      expect(views.map((t) => t.id)).toEqual(Object.keys(ops.trucks).sort());
      for (const t of views) {
        expect(t.pose).toEqual(truckPose(config, ops.trucks[t.id]!));
        const dock = ops.trucks[t.id]!.dock_id;
        if (t.status === "docked" && dock) {
          expect(t.pose).toEqual(dockedTruckPose(config, dock));
          expect(ops.docks[dock]!.truck_id).toBe(t.id);
          docked++;
        }
      }
    }
    expect(docked).toBeGreaterThan(0);
  });

  it("summarises docks, trucks, tasks and vehicles from state", () => {
    const ops = latest.ops!;
    const s = opsSummary(ops);
    expect(s.docks).toBe(4);
    expect(s.docksOccupied).toBe(Object.values(ops.docks).filter((d) => d.truck_id).length);
    expect(s.tasks).toBe(Object.keys(ops.tasks).length);
    expect(Object.values(s.tasksByStatus).reduce((a, b) => a + b, 0)).toBe(s.tasks);
    expect(s.vehiclesBusy).toBe(Object.values(ops.equipment).filter((e) => e.task_id).length);
  });
});

describe("free stock", () => {
  it("counts stored, unallocated pallets, which is exactly what an order can take", () => {
    const empty = createScenario("empty").config;
    const cmd = (command_id: string, type: string, payload: unknown) =>
      ({ command_id, type, payload }) as SimulationCommand;
    const stocked = step(empty, createInitialState(empty), [
      cmd("r1", "inventory.receive", {
        location_id: "loc-01-002",
        sku: "sku-electronics",
        quantity: 3,
      }),
    ]).state;
    expect(freeStock(stocked.ops!)).toEqual({ "sku-electronics": 3 });
    const order = (quantity: number, id: string) =>
      cmd(id, "order.create", { lines: [{ sku: "sku-electronics", quantity }] });
    const tooMany = step(empty, stocked, [order(4, "too-many")]);
    expect(tooMany.rejections.map((r) => r.code)).toEqual(["INSUFFICIENT_STOCK"]);
    const exact = step(empty, stocked, [order(3, "exact")]);
    expect(exact.rejections).toEqual([]);
    expect(freeStock(exact.state.ops!)).toEqual({});
  });
});
