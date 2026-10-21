import { TASK_TYPES, type DomainEvent, type SimulationCommand } from "@warehouse-one/contracts";
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
const cmd = (type: string, payload: unknown) =>
  ({ command_id: `w-${++n}`, type, payload }) as SimulationCommand;

interface Run {
  state: SimulationState;
  events: DomainEvent[];
}

/** Step until `done` (or a tick budget), checking every invariant and the speed limit each tick. */
function runUntil(
  config: SimulationConfig,
  start: Run,
  done: (r: Run) => boolean,
  budget: number,
): Run {
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
      if (moved * 1000 > SPEED_MM_PER_TICK[e.kind].empty + 1)
        throw new Error(`tick ${r.state.tick}: ${e.id} jumped ${moved} m`);
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
    let r = begin(
      config,
      cmd("inventory.receive", { location_id: "loc-02-003", sku: "sku-cold-chain", quantity: 5 }),
    );
    const relocate = cmd("pallet.relocate", {
      pallet_id: "plt-000005",
      to_location_id: "loc-05-012",
    });
    const s = step(config, r.state, [relocate]);
    r = { state: s.state, events: [...r.events, ...s.events] };
    r = runUntil(config, r, (x) => of(x, "task.completed").length === 1, 3000);

    // Pallet 5 was at slot 4 (level 2) and is now in the lowest free slot of the target bay.
    expect(r.state.ops!.pallets["plt-000005"]!.at).toEqual({
      kind: "slot",
      location_id: "loc-05-012",
      slot: 0,
    });
    expect(r.state.inventory["loc-02-003"]).toEqual({ "sku-cold-chain": 4 });
    expect(r.state.inventory["loc-05-012"]).toEqual({ "sku-cold-chain": 1 });

    const task = r.events.filter((e) => e.aggregate_id === "tsk-000001").map((e) => e.event_type);
    expect(task).toEqual(["task.created", "task.assigned", "task.completed"]);
    const moves = payloads<{ from: { kind: string }; to: { kind: string }; task_id: string }>(
      r,
      "pallet.moved",
    );
    expect(moves.map((m) => [m.from.kind, m.to.kind, m.task_id])).toEqual([
      ["slot", "equipment", "tsk-000001"],
      ["equipment", "slot", "tsk-000001"],
    ]);
    // Every event of the workflow carries the operator command's correlation id.
    for (const e of r.events.filter(
      (x) => x.aggregate_id === "tsk-000001" || x.event_type === "pallet.moved",
    )) {
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
    let r = begin(
      config,
      cmd("inventory.receive", { location_id: "loc-00-001", sku: "sku-std-pallet", quantity: 1 }),
    );
    const s = step(config, r.state, [
      cmd("pallet.relocate", { pallet_id: "plt-000001", to_location_id: "loc-00-014" }),
    ]);
    r = { state: s.state, events: [...r.events, ...s.events] };
    r = runUntil(config, r, (x) => of(x, "task.completed").length === 1, 3000);
    const id = (of(r, "task.completed")[0]!.payload as { equipment_id: string }).equipment_id;
    const g = navGraph(config);
    r = runUntil(
      config,
      r,
      (x) =>
        x.state.ops!.equipment[id]!.node === g.chargerNode.get(id) &&
        x.state.ops!.equipment[id]!.status !== "travelling",
      3000,
    );
    expect(["idle", "charging"]).toContain(r.state.ops!.equipment[id]!.status);
  });
});

describe("inbound workflow (truck → unload → staging → put-away)", () => {
  const { config } = createScenario("empty");

  it("unloads every pallet, puts it away, and the truck departs from its dock", () => {
    let r = begin(
      config,
      cmd("truck.schedule_inbound", {
        cargo: [
          { sku: "sku-bulk-bags", quantity: 3 },
          { sku: "sku-electronics", quantity: 2 },
        ],
      }),
    );
    r = runUntil(
      config,
      r,
      (x) => payloads<{ to: string }>(x, "truck.status_changed").some((p) => p.to === "departed"),
      8000,
    );
    const truckStates = payloads<{ to: string; dock_id: string | null }>(
      r,
      "truck.status_changed",
    ).map((p) => p.to);
    expect(truckStates).toEqual(["yard", "docking", "docked", "departing", "departed"]);
    const types = payloads<{ task_type: string }>(r, "task.created").map((p) => p.task_type);
    expect(types.filter((t) => t === "unload")).toHaveLength(5);
    r = runUntil(
      config,
      r,
      (x) => Object.keys(x.state.ops!.tasks).length === 0 && of(x, "task.completed").length === 10,
      8000,
    );
    // All five pallets ended up in rack slots, and the dock is free again.
    const pallets = Object.values(r.state.ops!.pallets);
    expect(pallets).toHaveLength(5);
    expect(pallets.every((p) => p.at.kind === "slot")).toBe(true);
    expect(Object.values(r.state.ops!.docks).every((d) => d.truck_id === null)).toBe(true);
    // Only counterbalance forklifts unload trailers.
    const unloadTasks = new Set(
      payloads<{ task_id: string; task_type: string }>(r, "task.created")
        .filter((p) => p.task_type === "unload")
        .map((p) => p.task_id),
    );
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
      cmd("order.create", {
        lines: [
          { sku: "sku-std-pallet", quantity: 3 },
          { sku: "sku-electronics", quantity: 1 },
        ],
      }),
    );
    r = runUntil(
      config,
      r,
      (x) => payloads<{ to: string }>(x, "order.status_changed").some((p) => p.to === "shipped"),
      10000,
    );
    expect(payloads<{ to: string }>(r, "order.status_changed").map((p) => p.to)).toEqual([
      "open",
      "in_progress",
      "shipped",
    ]);
    const created = payloads<{ task_type: string }>(r, "task.created").map((p) => p.task_type);
    expect(created.filter((t) => t === "pick")).toHaveLength(4);
    expect(created.filter((t) => t === "load")).toHaveLength(4);
    const shipped = payloads<{ reason: string; sku: string }>(r, "pallet.removed");
    expect(shipped.map((p) => p.reason)).toEqual(["shipped", "shipped", "shipped", "shipped"]);
    // Stock on site reconciles: 6 received − 4 shipped.
    expect(Object.keys(r.state.ops!.pallets)).toHaveLength(2);
    expect(r.state.inventory).toEqual({
      "loc-01-004": { "sku-std-pallet": 1 },
      "loc-03-009": { "sku-electronics": 1 },
    });
  });
});

interface SoakResult {
  created: number;
  completed: number;
  completedAt: number[];
  completedTypes: Set<string>;
  longestWait: number;
  longestService: number;
  backlog: number;
  /** Outbound orders: creation tick and final status, from `order.status_changed`. */
  orders: Map<string, { createdAt: number; status: string }>;
  /** Inbound trucks: arrival tick (entered the yard) and last status, from `truck.status_changed`. */
  inbound: Map<string, { arrivedAt: number; status: string }>;
  ticks: number;
  final: SimulationState;
}

/**
 * Run a scenario for `ticks`, checking invariants every 100 ticks, and measure liveness and
 * workflow outcomes from the event stream. Events of the opening step (tick 1) are included, so
 * tasks, orders and trucks created by opening commands are counted like any others.
 */
function soak(config: SimulationConfig, opening: readonly unknown[], ticks: number): SoakResult {
  const r: SoakResult = {
    created: 0,
    completed: 0,
    completedAt: [],
    completedTypes: new Set(),
    longestWait: 0,
    longestService: 0,
    backlog: 0,
    orders: new Map(),
    inbound: new Map(),
    ticks: 0,
    final: createInitialState(config),
  };
  const assignedAt = new Map<string, number>();
  const taskType = new Map<string, string>();
  const record = (events: readonly DomainEvent[], tick: number) => {
    for (const e of events) {
      switch (e.event_type) {
        case "task.created":
          r.created++;
          taskType.set(e.payload.task_id, e.payload.task_type);
          break;
        case "task.assigned":
          assignedAt.set(e.aggregate_id, tick);
          break;
        case "task.completed":
          r.completed++;
          r.completedAt.push(tick);
          r.completedTypes.add(taskType.get(e.payload.task_id) ?? "unknown");
          r.longestService = Math.max(
            r.longestService,
            tick - (assignedAt.get(e.aggregate_id) ?? tick),
          );
          break;
        case "order.status_changed": {
          const o = r.orders.get(e.payload.order_id);
          r.orders.set(e.payload.order_id, {
            createdAt: o?.createdAt ?? tick,
            status: e.payload.to,
          });
          break;
        }
        case "truck.status_changed": {
          if (e.payload.direction !== "inbound") break;
          const t = r.inbound.get(e.payload.truck_id);
          r.inbound.set(e.payload.truck_id, {
            arrivedAt: t?.arrivedAt ?? tick,
            status: e.payload.to,
          });
          break;
        }
      }
    }
  };
  const opened = step(config, createInitialState(config), opening);
  let s = opened.state;
  record(opened.events, s.tick);
  for (let i = 0; i < ticks; i++) {
    const out = step(config, s, []);
    s = out.state;
    record(out.events, s.tick);
    for (const e of Object.values(s.ops!.equipment))
      r.longestWait = Math.max(r.longestWait, e.wait_ticks);
    if (i % 100 === 0) {
      const v = checkInvariants(config, s);
      if (v.length) throw new Error(`tick ${s.tick}: ${v.join("; ")}`);
    }
  }
  expect(checkInvariants(config, s)).toEqual([]);
  r.backlog = Object.keys(s.ops!.tasks).length;
  r.ticks = s.tick;
  r.final = s;
  return r;
}

/** Liveness: work keeps completing, completions keep pace with demand, nobody waits for long. */
function expectLive(r: SoakResult, ticks: number) {
  for (let window = 0; window < ticks; window += 2000) {
    expect(
      r.completedAt.some((t) => t > window && t <= window + 2000),
      `no task completed in ticks ${window}–${window + 2000}`,
    ).toBe(true);
  }
  expect(r.completed / r.created).toBeGreaterThan(0.85);
  expect(r.backlog).toBeLessThan(20);
  // Waits are queueing behind a vehicle that is moving or handling, never a standstill.
  expect(r.longestWait).toBeLessThan(300);
}

/**
 * Completion margins: regression guards derived from the observed 12-seed showcase workload, not
 * universal performance guarantees. Measured (20,000 ticks × 12 seeds): orders take 1,575–5,511
 * ticks from creation to shipping, inbound trucks 352–3,125 ticks from arrival to departure. Orders
 * are slow because one task at a time may touch a dock (DEC-020), so an order's picks and loads run
 * in series. Changing the workload, layout or dispatcher requires revalidating these margins
 * (PHASE_2.md §5.1).
 */
const ORDER_MARGIN_TICKS = 6000;
const INBOUND_MARGIN_TICKS = 3500;

/**
 * Workflow completion, from events and the final authoritative state: orders created long enough
 * before the end have shipped, inbound trucks that arrived long enough before the end have left,
 * and every task type has completed at least once.
 */
function expectWorkflowsComplete(r: SoakResult) {
  const ops = r.final.ops!;
  const dueOrders = [...r.orders].filter(([, o]) => o.createdAt <= r.ticks - ORDER_MARGIN_TICKS);
  expect(dueOrders.length).toBeGreaterThan(0);
  for (const [id, o] of dueOrders) {
    expect(o.status, `order ${id} created at tick ${o.createdAt}`).toBe("shipped");
    expect(ops.orders[id], `shipped order ${id} still in state`).toBeUndefined();
  }
  const dueTrucks = [...r.inbound].filter(([, t]) => t.arrivedAt <= r.ticks - INBOUND_MARGIN_TICKS);
  expect(dueTrucks.length).toBeGreaterThan(0);
  for (const [id, t] of dueTrucks) {
    expect(t.status, `inbound truck ${id} arrived at tick ${t.arrivedAt}`).toBe("departed");
    expect(ops.trucks[id], `departed truck ${id} still in state`).toBeUndefined();
  }
  expect([...r.completedTypes].sort()).toEqual([...TASK_TYPES].sort());
}

/** The 12 seeds of the stabilisation sweep (PHASE_2.md §4, §5.1). */
const SOAK_SEEDS = [
  "warehouse-one-showcase",
  ...Array.from({ length: 11 }, (_, i) => `s-${i + 1}`),
];

describe("showcase soak run (12 seeds × 20,000 ticks)", () => {
  const scenario = createScenario("showcase");

  it.each(SOAK_SEEDS)(
    "seed %s: keeps every invariant, never stalls, and completes its workflows",
    (seed) => {
      const config: SimulationConfig = { ...scenario.config, seed };
      const r = soak(config, scenario.openingCommands, 20000);
      expectLive(r, 20000);
      expectWorkflowsComplete(r);
      // Acceptance target for the showcase: no assigned task takes more than 3 simulated minutes
      // (1,800 ticks). Not applied to bench-1000, whose longest free-flow trip exceeds it (§5.1).
      expect(r.longestService).toBeLessThan(1800);
      // Secondary sanity check on the workload generator, not the proof of liveness (the window,
      // ratio, backlog, wait and workflow assertions above are): 12 seeds complete 78–93 tasks.
      expect(r.completed).toBeGreaterThan(60);
    },
    30_000,
  );
});
