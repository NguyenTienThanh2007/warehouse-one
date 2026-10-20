import { describe, expect, it } from "vitest";
import { DomainEvent, EVENT_PAYLOADS, EVENT_TYPES, parseCommand, PalletPosition, TRUCK_CAPACITY } from "./index";

const envelope = {
  event_id: "0f8fad5b-d9cb-869f-a165-70867728950e",
  schema_version: 1,
  aggregate_version: 1,
  simulation_id: "6c0b7c8e-2f43-4a59-9a3e-5d1f0c2b7a10",
  sequence: 7,
  occurred_at: "2026-01-05T06:00:01.000Z",
  simulation_time_ms: 1000,
  correlation_id: "c1",
  causation_id: "c1",
};

describe("Phase 2 commands", () => {
  it.each([
    ["inbound truck", { type: "truck.schedule_inbound", payload: { cargo: [{ sku: "sku-a", quantity: 4 }, { sku: "sku-b", quantity: 2 }] } }],
    ["order", { type: "order.create", payload: { lines: [{ sku: "sku-a", quantity: TRUCK_CAPACITY }] } }],
    ["cancel", { type: "order.cancel", payload: { order_id: "ord-000001" } }],
    ["relocate", { type: "pallet.relocate", payload: { pallet_id: "plt-000001", to_location_id: "loc-00-001" } }],
  ])("accepts a valid %s command", (_n, c) => {
    expect(parseCommand({ command_id: "c", ...c }).ok).toBe(true);
  });

  it.each([
    ["more than one truck", { type: "order.create", payload: { lines: [{ sku: "sku-a", quantity: 20 }, { sku: "sku-b", quantity: 7 }] } }],
    ["a duplicated SKU", { type: "order.create", payload: { lines: [{ sku: "sku-a", quantity: 1 }, { sku: "sku-a", quantity: 1 }] } }],
    ["no lines", { type: "truck.schedule_inbound", payload: { cargo: [] } }],
    ["a zero quantity", { type: "truck.schedule_inbound", payload: { cargo: [{ sku: "sku-a", quantity: 0 }] } }],
    ["a malformed pallet id", { type: "pallet.relocate", payload: { pallet_id: "PLT 1", to_location_id: "loc-00-001" } }],
  ])("rejects %s", (_n, c) => {
    expect(parseCommand({ command_id: "c", ...c }).ok).toBe(false);
  });
});

describe("Phase 2 events", () => {
  it("declare one aggregate type per event type", () => {
    for (const t of EVENT_TYPES) expect(EVENT_PAYLOADS[t].aggregate).toMatch(/^[a-z_]+$/);
    expect(EVENT_PAYLOADS["inventory.received"].aggregate).toBe("inventory_item");
    expect(EVENT_PAYLOADS["pallet.moved"].aggregate).toBe("pallet");
  });

  it("validate pallet movement between every position kind", () => {
    const positions = [
      { kind: "slot", location_id: "loc-00-001", slot: 3 },
      { kind: "staging", dock_id: "dock-01", position: 0 },
      { kind: "equipment", equipment_id: "fl-01" },
      { kind: "truck", truck_id: "trk-000001", position: 5 },
    ];
    for (const p of positions) expect(PalletPosition.safeParse(p).success).toBe(true);
    const moved = {
      ...envelope,
      event_type: "pallet.moved",
      aggregate_type: "pallet",
      aggregate_id: "plt-000001",
      payload: { pallet_id: "plt-000001", sku: "sku-a", from: positions[0], to: positions[2], task_id: "tsk-000001" },
    };
    expect(DomainEvent.safeParse(moved).success).toBe(true);
    expect(DomainEvent.safeParse({ ...moved, payload: { ...moved.payload, task_id: null } }).success).toBe(true);
  });

  it("reject a mismatched aggregate type and unknown statuses", () => {
    const ev = {
      ...envelope,
      event_type: "equipment.status_changed",
      aggregate_type: "equipment",
      aggregate_id: "fl-01",
      payload: { equipment_id: "fl-01", from: "idle", to: "travelling", node_id: "n-1", task_id: null, battery_permille: 900 },
    };
    expect(DomainEvent.safeParse(ev).success).toBe(true);
    expect(DomainEvent.safeParse({ ...ev, aggregate_type: "pallet" }).success).toBe(false);
    expect(DomainEvent.safeParse({ ...ev, payload: { ...ev.payload, to: "flying" } }).success).toBe(false);
    expect(DomainEvent.safeParse({ ...ev, payload: { ...ev.payload, battery_permille: 1001 } }).success).toBe(false);
  });
});
