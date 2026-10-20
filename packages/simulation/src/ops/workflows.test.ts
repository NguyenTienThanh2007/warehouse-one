import type { DomainEvent, SimulationCommand } from "@warehouse-one/contracts";
import { DomainEvent as DomainEventSchema } from "@warehouse-one/contracts";
import { describe, expect, it } from "vitest";
import {
  checkInvariants,
  createInitialState,
  createScenario,
  equipmentPose,
  navGraph,
  SPEED_MM_PER_TICK,
  step,
  type SimulationConfig,
  type SimulationState,
} from "../index";

let n = 0;
const cmd = (type: string, payload: unknown) => ({ command_id: `w-${++n}`, type, payload }) as SimulationCommand;

interface Run {
  state: SimulationState;
  events: DomainEvent[];
}

/** Step until `done` (or a tick budget), checking every invariant and the speed limit each tick. */
function runUntil(config: SimulationConfig, start: Run, done: (r: Run) => boolean, budget: number): Run {
  const g = navGraph(config);
  const r: Run = { state: start.state, events: [...start.events] };
  for (let i = 0; i < budget && !done(r); i++) {
    const prev = r.state;
    const s = step(config, prev, []);
    r.state = s.state;
    r.events.push(...s.events);
    const violations = checkInvariants(config, r.state);
    if (violations.length) throw new Error(`tick ${r.state.tick}: ${violations.join("; ")}`);
    for (const e of Object.values(r.state.ops!.equipment)) {
      const before = equipmentPose(g, prev.ops!.equipment[e.id]!);
      const after = equipmentPose(g, e);
      const moved = Math.abs(after.x - before.x) + Math.abs(after.z - before.z);
      // Axis-aligned travel: Manhattan distance per tick never exceeds the vehicle's speed.
      if (moved * 1000 > SPEED_MM_PER_TICK[e.kind].empty + 1) throw new Error(`tick ${r.state.tick}: ${e.id} jumped ${moved} m`);
    }
  }
  if (!done(r)) throw new Error(`not done after ${budget} ticks`);
  return r;
}

function begin(config: SimulationConfig, ...commands: unknown[]): Run {
  const s = step(config, createInitialState(config), commands);
  expect(s.rejections).toEqual([]);
  return { state: s.state, events: [...s.events] };
}

const of = (r: Run, type: string) => r.events.filter((e) => e.event_type === type);
const payloads = <T>(r: Run, type: string) => of(r, type).map((e) => e.payload as T);

describe("relocation workflow (slot → forks → slot)", () => {
  const { config } = createScenario("empty");

  it("is traceable from task creation through assignment, movement, handling and completion", () => {
    let r = begin(config, cmd("inventory.receive", { location_id: "loc-02-003", sku: "sku-cold-chain", quantity: 5 }));
    const relocate = cmd("pallet.relocate", { pallet_id: "plt-000005", to_location_id: "loc-05-012" });
    const s = step(config, r.state, [relocate]);
    r = { state: s.state, events: [...r.events, ...s.events] };
    r = runUntil(config, r, (x) => of(x, "task.completed").length === 1, 3000);

    // Pallet 5 was at slot 4 (level 2) and is now in the lowest free slot of the target bay.
    expect(r.state.ops!.pallets["plt-000005"]!.at).toEqual({ kind: "slot", location_id: "loc-05-012", slot: 0 });
    expect(r.state.inventory["loc-02-003"]).toEqual({ "sku-cold-chain": 4 });
    expect(r.state.inventory["loc-05-012"]).toEqual({ "sku-cold-chain": 1 });

    const task = r.events.filter((e) => e.aggregate_id === "tsk-000001").map((e) => e.event_type);
    expect(task).toEqual(["task.created", "task.assigned", "task.completed"]);
    const moves = payloads<{ from: { kind: string }; to: { kind: string }; task_id: string }>(r, "pallet.moved");
    expect(moves.map((m) => [m.from.kind, m.to.kind, m.task_id])).toEqual([
      ["slot", "equipment", "tsk-000001"],
      ["equipment", "slot", "tsk-000001"],
    ]);
    // Every event of the workflow carries the operator command's correlation id.
    for (const e of r.events.filter((x) => x.aggregate_id === "tsk-000001" || x.event_type === "pallet.moved")) {
      expect(e.correlation_id).toBe(relocate.command_id);
    }
    const assignee = (of(r, "task.assigned")[0]!.payload as { equipment_id: string }).equipment_id;
    const statuses = r.events
      .filter((e) => e.event_type === "equipment.status_changed" && e.aggregate_id === assignee)
      .map((e) => (e.payload as { to: string }).to);
    // (A vehicle parked at home may first be opportunity-charging; it leaves the charger to work.)
    const work = statuses.slice(statuses.indexOf("travelling"));
    expect(work.slice(0, 4)).toEqual(["travelling", "handling", "travelling", "handling"]);
    // All events still satisfy the published contract.
    for (const e of r.events) expect(DomainEventSchema.safeParse(e).success).toBe(true);
  });

  it("returns the vehicle home afterwards and charges it", () => {
    let r = begin(config, cmd("inventory.receive", { location_id: "loc-00-001", sku: "sku-std-pallet", quantity: 1 }));
    const s = step(config, r.state, [cmd("pallet.relocate", { pallet_id: "plt-000001", to_location_id: "loc-00-014" })]);
    r = { state: s.state, events: [...r.events, ...s.events] };
    r = runUntil(config, r, (x) => of(x, "task.completed").length === 1, 3000);
    const id = (of(r, "task.completed")[0]!.payload as { equipment_id: string }).equipment_id;
    const g = navGraph(config);
    r = runUntil(config, r, (x) => x.state.ops!.equipment[id]!.node === g.chargerNode.get(id) && x.state.ops!.equipment[id]!.status !== "travelling", 3000);
    expect(["idle", "charging"]).toContain(r.state.ops!.equipment[id]!.status);
  });
});

describe("inbound workflow (truck → unload → staging → put-away)", () => {
  const { config } = createScenario("empty");

  it("unloads every pallet, puts it away, and the truck departs from its dock", () => {
    let r = begin(config, cmd("truck.schedule_inbound", { cargo: [{ sku: "sku-bulk-bags", quantity: 3 }, { sku: "sku-electronics", quantity: 2 }] }));
    r = runUntil(config, r, (x) => payloads<{ to: string }>(x, "truck.status_changed").some((p) => p.to === "departed"), 8000);
    const truckStates = payloads<{ to: string; dock_id: string | null }>(r, "truck.status_changed").map((p) => p.to);
    expect(truckStates).toEqual(["yard", "docking", "docked", "departing", "departed"]);
    const types = payloads<{ task_type: string }>(r, "task.created").map((p) => p.task_type);
    expect(types.filter((t) => t === "unload")).toHaveLength(5);
    r = runUntil(config, r, (x) => Object.keys(x.state.ops!.tasks).length === 0 && of(x, "task.completed").length === 10, 8000);
    // All five pallets ended up in rack slots, and the dock is free again.
    const pallets = Object.values(r.state.ops!.pallets);
    expect(pallets).toHaveLength(5);
    expect(pallets.every((p) => p.at.kind === "slot")).toBe(true);
    expect(Object.values(r.state.ops!.docks).every((d) => d.truck_id === null)).toBe(true);
    // Only counterbalance forklifts unload trailers.
    const unloadTasks = new Set(payloads<{ task_id: string; task_type: string }>(r, "task.created").filter((p) => p.task_type === "unload").map((p) => p.task_id));
    for (const a of payloads<{ task_id: string; equipment_id: string }>(r, "task.assigned")) {
      if (unloadTasks.has(a.task_id)) expect(a.equipment_id).toMatch(/^fl-/);
    }
  });
});

describe("outbound workflow (order → pick → staging → load → ship)", () => {
  const { config } = createScenario("empty");

  it("picks, stages and loads the allocated pallets, then ships the order", () => {
    let r = begin(
      config,
      cmd("inventory.receive", { location_id: "loc-01-004", sku: "sku-std-pallet", quantity: 4 }),
      cmd("inventory.receive", { location_id: "loc-03-009", sku: "sku-electronics", quantity: 2 }),
      cmd("order.create", { lines: [{ sku: "sku-std-pallet", quantity: 3 }, { sku: "sku-electronics", quantity: 1 }] }),
    );
    r = runUntil(config, r, (x) => payloads<{ to: string }>(x, "order.status_changed").some((p) => p.to === "shipped"), 10000);
    expect(payloads<{ to: string }>(r, "order.status_changed").map((p) => p.to)).toEqual(["open", "in_progress", "shipped"]);
    const created = payloads<{ task_type: string }>(r, "task.created").map((p) => p.task_type);
    expect(created.filter((t) => t === "pick")).toHaveLength(4);
    expect(created.filter((t) => t === "load")).toHaveLength(4);
    const shipped = payloads<{ reason: string; sku: string }>(r, "pallet.removed");
    expect(shipped.map((p) => p.reason)).toEqual(["shipped", "shipped", "shipped", "shipped"]);
    // Stock on site reconciles: 6 received − 4 shipped.
    expect(Object.keys(r.state.ops!.pallets)).toHaveLength(2);
    expect(r.state.inventory).toEqual({ "loc-01-004": { "sku-std-pallet": 1 }, "loc-03-009": { "sku-electronics": 1 } });
  });
});

describe("showcase soak run", () => {
  const scenario = createScenario("showcase");
  const config = scenario.config;

  it("keeps every invariant, never deadlocks, and keeps completing work for 20,000 ticks", () => {
    let s = step(config, createInitialState(config), scenario.openingCommands).state;
    const completedAt: number[] = [];
    const assignedAt = new Map<string, number>();
    const longestWait: Record<string, number> = {};
    let longestService = 0;
    for (let i = 0; i < 20000; i++) {
      const r = step(config, s, []);
      s = r.state;
      for (const e of r.events) {
        if (e.event_type === "task.assigned") assignedAt.set(e.aggregate_id, s.tick);
        if (e.event_type === "task.completed") {
          completedAt.push(s.tick);
          longestService = Math.max(longestService, s.tick - (assignedAt.get(e.aggregate_id) ?? s.tick));
        }
      }
      for (const e of Object.values(s.ops!.equipment)) longestWait[e.id] = Math.max(longestWait[e.id] ?? 0, e.wait_ticks);
      if (i % 100 === 0) expect(checkInvariants(config, s)).toEqual([]);
    }
    expect(checkInvariants(config, s)).toEqual([]);
    // Liveness: work completes throughout the run, not just at the start.
    expect(completedAt.length).toBeGreaterThan(150);
    for (let window = 0; window < 20000; window += 2000) {
      expect(completedAt.some((t) => t > window && t <= window + 2000), `no task completed in ticks ${window}–${window + 2000}`).toBe(true);
    }
    // No vehicle waits long at one node, and no assigned task takes more than ~3 simulated minutes.
    for (const [id, w] of Object.entries(longestWait)) expect(w, id).toBeLessThan(600);
    expect(longestService).toBeLessThan(1800);
    // Queues stay bounded at this workload.
    expect(Object.keys(s.ops!.tasks).length).toBeLessThan(40);
  });
});
