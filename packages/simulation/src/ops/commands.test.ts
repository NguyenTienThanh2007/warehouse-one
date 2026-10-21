import type { SimulationCommand } from "@warehouse-one/contracts";
import { describe, expect, it } from "vitest";
import {
  checkInvariants,
  createFoundationDemoConfig,
  createInitialState,
  createScenario,
  stateHash,
  step,
  type SimulationState,
} from "../index";

const { config } = createScenario("empty");
let n = 0;
const cmd = (type: string, payload: unknown) =>
  ({ command_id: `t-${++n}`, type, payload }) as SimulationCommand;
const receive = (location_id: string, sku: string, quantity: number) =>
  cmd("inventory.receive", { location_id, sku, quantity });

function apply(state: SimulationState, ...commands: unknown[]) {
  const r = step(config, state, commands);
  expect(checkInvariants(config, r.state)).toEqual([]);
  return r;
}
const pallets = (s: SimulationState) => Object.values(s.ops!.pallets);
/** Events caused directly by one command (systems that run later in the tick use other ids). */
const eventsOf = (
  r: { events: readonly { correlation_id: string; causation_id: string; event_type: string }[] },
  commandId: string,
) => r.events.filter((e) => e.causation_id === commandId).map((e) => e.event_type);
const lastId = () => `t-${n}`;

describe("inventory commands with pallet tracking", () => {
  it("receive creates one pallet per unit in the lowest free slots and keeps the inventory projection", () => {
    const r = apply(createInitialState(config), receive("loc-00-001", "sku-std-pallet", 3));
    expect(pallets(r.state).map((p) => p.at)).toEqual(
      [0, 1, 2].map((slot) => ({ kind: "slot", location_id: "loc-00-001", slot })),
    );
    expect(r.state.inventory).toEqual({ "loc-00-001": { "sku-std-pallet": 3 } });
    expect(eventsOf(r, lastId())).toEqual([
      "inventory.received",
      "pallet.created",
      "pallet.created",
      "pallet.created",
    ]);
    expect(r.events[0]!.payload).toMatchObject({ location_quantity_after: 3 });
  });

  it("move relocates unallocated pallets from the top and adjust removes or adds pallets", () => {
    let s = apply(createInitialState(config), receive("loc-00-001", "sku-std-pallet", 4)).state;
    const m = apply(
      s,
      cmd("inventory.move", {
        from_location_id: "loc-00-001",
        to_location_id: "loc-00-002",
        sku: "sku-std-pallet",
        quantity: 2,
      }),
    );
    s = m.state;
    expect(s.inventory).toEqual({
      "loc-00-001": { "sku-std-pallet": 2 },
      "loc-00-002": { "sku-std-pallet": 2 },
    });
    // Taken from slots 3 and 2 (top first), placed into 0 and 1.
    const moved = m.events
      .filter((e) => e.event_type === "pallet.moved")
      .map((e) => e.payload as { from: { slot: number }; to: { slot: number }; task_id: null });
    expect(moved.map((x) => [x.from.slot, x.to.slot, x.task_id])).toEqual([
      [3, 0, null],
      [2, 1, null],
    ]);
    s = apply(
      s,
      cmd("inventory.adjust", {
        location_id: "loc-00-001",
        sku: "sku-std-pallet",
        delta: -1,
        reason: "damage",
      }),
    ).state;
    s = apply(
      s,
      cmd("inventory.adjust", {
        location_id: "loc-00-003",
        sku: "sku-cold-chain",
        delta: 2,
        reason: "correction",
      }),
    ).state;
    expect(s.inventory).toEqual({
      "loc-00-001": { "sku-std-pallet": 1 },
      "loc-00-002": { "sku-std-pallet": 2 },
      "loc-00-003": { "sku-cold-chain": 2 },
    });
    expect(pallets(s)).toHaveLength(5);
  });

  it("does not let administrative commands touch allocated pallets", () => {
    let s = apply(createInitialState(config), receive("loc-00-001", "sku-std-pallet", 2)).state;
    s = apply(s, cmd("order.create", { lines: [{ sku: "sku-std-pallet", quantity: 2 }] })).state;
    const r = apply(
      s,
      cmd("inventory.adjust", {
        location_id: "loc-00-001",
        sku: "sku-std-pallet",
        delta: -1,
        reason: "damage",
      }),
    );
    expect(r.rejections[0]?.code).toBe("PALLET_RESERVED");
  });
});

describe("trucks and orders", () => {
  it("an inbound truck arrives in the yard carrying new pallets and is given a free dock", () => {
    const r = apply(
      createInitialState(config),
      cmd("truck.schedule_inbound", {
        cargo: [
          { sku: "sku-bulk-bags", quantity: 2 },
          { sku: "sku-electronics", quantity: 1 },
        ],
      }),
    );
    const truck = r.state.ops!.trucks["trk-000001"]!;
    // Arrives in the yard (command), then the yard system assigns the first free dock in the same tick.
    expect(truck).toMatchObject({
      direction: "inbound",
      status: "docking",
      dock_id: "dock-01",
      yard_slot: 0,
    });
    const changes = r.events
      .filter((e) => e.event_type === "truck.status_changed")
      .map((e) => [(e.payload as { from: string | null }).from, (e.payload as { to: string }).to]);
    expect(changes).toEqual([
      [null, "yard"],
      ["yard", "docking"],
    ]);
    expect(pallets(r.state).map((p) => [p.sku, p.at])).toEqual([
      ["sku-bulk-bags", { kind: "truck", truck_id: "trk-000001", position: 0 }],
      ["sku-bulk-bags", { kind: "truck", truck_id: "trk-000001", position: 1 }],
      ["sku-electronics", { kind: "truck", truck_id: "trk-000001", position: 2 }],
    ]);
    expect(r.state.inventory).toEqual({}); // not in storage yet
    expect(eventsOf(r, lastId())).toEqual([
      "truck.status_changed",
      "pallet.created",
      "pallet.created",
      "pallet.created",
    ]);
  });

  it("rejects trucks when the yard is full or storage could not absorb the cargo", () => {
    let s = createInitialState(config);
    for (let i = 0; i < 4; i++)
      s = apply(
        s,
        cmd("truck.schedule_inbound", { cargo: [{ sku: "sku-std-pallet", quantity: 1 }] }),
      ).state;
    expect(
      apply(s, cmd("truck.schedule_inbound", { cargo: [{ sku: "sku-std-pallet", quantity: 1 }] }))
        .rejections[0]?.code,
    ).toBe("YARD_FULL");

    const small = createScenario("bench-100").config; // 112 positions, 100 stored
    let b = step(
      small,
      createInitialState(small),
      createScenario("bench-100").openingCommands,
    ).state;
    const r = step(small, b, [
      cmd("truck.schedule_inbound", { cargo: [{ sku: "sku-std-pallet", quantity: 13 }] }),
    ]);
    expect(r.rejections[0]).toMatchObject({ code: "NO_CAPACITY" });
    b = step(small, b, [
      cmd("truck.schedule_inbound", { cargo: [{ sku: "sku-std-pallet", quantity: 12 }] }),
    ]).state;
    expect(checkInvariants(small, b)).toEqual([]);
  });

  it("an order allocates the oldest available pallets and schedules an outbound truck", () => {
    let s = apply(
      createInitialState(config),
      receive("loc-00-001", "sku-std-pallet", 3),
      receive("loc-00-002", "sku-std-pallet", 2),
    ).state;
    const r = apply(s, cmd("order.create", { lines: [{ sku: "sku-std-pallet", quantity: 4 }] }));
    s = r.state;
    const order = s.ops!.orders["ord-000001"]!;
    // A dock was free, so the order went straight to in_progress and picking began.
    expect(order).toMatchObject({
      status: "in_progress",
      truck_id: "trk-000001",
      pallet_ids: ["plt-000001", "plt-000002", "plt-000003", "plt-000004"],
    });
    expect(s.ops!.trucks["trk-000001"]).toMatchObject({
      direction: "outbound",
      status: "docking",
      order_id: "ord-000001",
    });
    expect(eventsOf(r, lastId())).toEqual(["order.status_changed", "truck.status_changed"]);
    expect(s.ops!.pallets["plt-000005"]!.order_id).toBeNull();
    // Only one unallocated pallet is left.
    const second = apply(
      s,
      cmd("order.create", { lines: [{ sku: "sku-std-pallet", quantity: 2 }] }),
    );
    expect(second.rejections[0]).toMatchObject({
      code: "INSUFFICIENT_STOCK",
      message: "'sku-std-pallet': 1 pallets available, 2 requested",
    });
  });

  it("cancelling an order that is still waiting for a dock releases its pallets and sends the truck away", () => {
    let s = apply(createInitialState(config), receive("loc-00-001", "sku-std-pallet", 2)).state;
    // Occupy all four docks with inbound trucks, then let them finish docking (frees their yard slots).
    for (let i = 0; i < 4; i++)
      s = apply(
        s,
        cmd("truck.schedule_inbound", { cargo: [{ sku: "sku-bulk-bags", quantity: 1 }] }),
      ).state;
    for (let i = 0; i < 81; i++) s = step(config, s).state;
    expect(Object.values(s.ops!.docks).every((d) => d.truck_id !== null)).toBe(true);
    s = apply(s, cmd("order.create", { lines: [{ sku: "sku-std-pallet", quantity: 2 }] })).state;
    const orderId = Object.keys(s.ops!.orders)[0]!;
    const truckId = s.ops!.orders[orderId]!.truck_id;
    expect(s.ops!.orders[orderId]!.status).toBe("open");
    const r = apply(s, cmd("order.cancel", { order_id: orderId }));
    expect(r.state.ops!.orders).toEqual({});
    expect(pallets(r.state).every((p) => p.order_id === null)).toBe(true);
    expect(r.state.ops!.trucks[truckId]).toMatchObject({ status: "departing", dock_id: null });
    expect(apply(r.state, cmd("order.cancel", { order_id: orderId })).rejections[0]?.code).toBe(
      "UNKNOWN_ORDER",
    );
  });

  it("refuses to cancel an order once its truck has a dock", () => {
    let s = apply(createInitialState(config), receive("loc-00-001", "sku-std-pallet", 2)).state;
    s = apply(s, cmd("order.create", { lines: [{ sku: "sku-std-pallet", quantity: 2 }] })).state;
    const r = apply(s, cmd("order.cancel", { order_id: "ord-000001" }));
    expect(r.rejections[0]).toMatchObject({ code: "ORDER_NOT_CANCELLABLE" });
    expect(r.state.ops!.orders["ord-000001"]).toBeDefined();
  });
});

describe("pallet relocation", () => {
  const stocked = () =>
    apply(
      createInitialState(config),
      receive("loc-00-001", "sku-std-pallet", 2),
      receive("loc-00-002", "sku-cold-chain", 8),
    ).state;

  it("creates a pending task that reserves the lowest free slot of the target bay", () => {
    const r = apply(
      stocked(),
      cmd("pallet.relocate", { pallet_id: "plt-000002", to_location_id: "loc-01-005" }),
    );
    const task = r.state.ops!.tasks["tsk-000001"]!;
    // Created pending by the command, then assigned by the dispatcher in the same tick.
    expect(task).toMatchObject({
      type: "relocate",
      status: "assigned",
      pallet_id: "plt-000002",
      from: { kind: "slot", location_id: "loc-00-001", slot: 1 },
      to: { kind: "slot", location_id: "loc-01-005", slot: 0 },
    });
    expect(r.state.ops!.reservations).toEqual({ "slot:loc-01-005:0": "tsk-000001" });
    expect(r.state.ops!.pallets["plt-000002"]!.task_id).toBe("tsk-000001");
    expect(eventsOf(r, lastId())).toEqual(["task.created"]);
    expect(r.events.some((e) => e.event_type === "task.assigned")).toBe(true);
  });

  it.each([
    [
      "an unknown pallet",
      { pallet_id: "plt-999999", to_location_id: "loc-01-005" },
      "UNKNOWN_PALLET",
    ],
    [
      "an unknown bay",
      { pallet_id: "plt-000001", to_location_id: "loc-99-999" },
      "UNKNOWN_LOCATION",
    ],
    ["the same bay", { pallet_id: "plt-000001", to_location_id: "loc-00-001" }, "SAME_LOCATION"],
    ["a full bay", { pallet_id: "plt-000001", to_location_id: "loc-00-002" }, "NO_CAPACITY"],
  ])("rejects %s without changing state", (_name, payload, code) => {
    const s = stocked();
    const r = step(config, s, [cmd("pallet.relocate", payload)]);
    expect(r.rejections[0]?.code).toBe(code);
    // Identical to the same tick without the command: the rejection changed nothing.
    const baseline = step(config, s, []);
    expect(stateHash(config, r.state)).toBe(stateHash(config, baseline.state));
    expect(r.events).toEqual(baseline.events);
  });

  it("rejects a pallet that already has a task, and a reserved slot is not offered twice", () => {
    let s = apply(
      stocked(),
      cmd("pallet.relocate", { pallet_id: "plt-000001", to_location_id: "loc-01-005" }),
    ).state;
    expect(
      apply(s, cmd("pallet.relocate", { pallet_id: "plt-000001", to_location_id: "loc-01-006" }))
        .rejections[0]?.code,
    ).toBe("PALLET_RESERVED");
    s = apply(
      s,
      cmd("pallet.relocate", { pallet_id: "plt-000002", to_location_id: "loc-01-005" }),
    ).state;
    expect(s.ops!.tasks["tsk-000002"]!.to).toEqual({
      kind: "slot",
      location_id: "loc-01-005",
      slot: 1,
    });
  });

  it("same-tick conflicting commands resolve in submission order", () => {
    const r = apply(
      apply(createInitialState(config), receive("loc-00-001", "sku-std-pallet", 1)).state,
      cmd("order.create", { lines: [{ sku: "sku-std-pallet", quantity: 1 }] }),
      cmd("pallet.relocate", { pallet_id: "plt-000001", to_location_id: "loc-01-005" }),
    );
    expect(r.rejections.map((x) => x.code)).toEqual(["PALLET_RESERVED"]);
  });
});

describe("configs without facility data", () => {
  it("reject operational commands and keep the Phase 0 state shape", () => {
    const foundation = createFoundationDemoConfig();
    const r = step(foundation, createInitialState(foundation), [
      cmd("order.create", { lines: [{ sku: "sku-std-pallet", quantity: 1 }] }),
    ]);
    expect(r.rejections[0]?.code).toBe("OPERATIONS_DISABLED");
    expect("ops" in r.state).toBe(false);
  });
});
