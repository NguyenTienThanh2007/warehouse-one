import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DomainEvent, EVENT_PAYLOADS, EVENT_TYPES, parseCommand } from "./index";
import { renderJsonSchema, SCHEMA_FILES } from "./json-schema";

const schemasDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/schemas");

const validEvent = {
  event_id: "0f8fad5b-d9cb-869f-a165-70867728950e",
  event_type: "inventory.received",
  schema_version: 1,
  aggregate_type: "inventory_item",
  aggregate_id: "sku-std-pallet",
  aggregate_version: 1,
  simulation_id: "6c0b7c8e-2f43-4a59-9a3e-5d1f0c2b7a10",
  sequence: 1,
  occurred_at: "2026-01-05T06:00:00.100Z",
  simulation_time_ms: 100,
  correlation_id: "cmd-1",
  causation_id: "cmd-1",
  payload: { location_id: "loc-a01", sku: "sku-std-pallet", quantity: 4, location_quantity_after: 4 },
};

describe("command contracts", () => {
  it("accepts a well-formed command", () => {
    const r = parseCommand({
      command_id: "c1",
      type: "inventory.move",
      payload: { from_location_id: "loc-a01", to_location_id: "loc-a02", sku: "sku-x", quantity: 2 },
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ["unknown type", { command_id: "c", type: "inventory.teleport", payload: {} }],
    ["zero quantity", { command_id: "c", type: "inventory.receive", payload: { location_id: "loc-a", sku: "sku-a", quantity: 0 } }],
    ["fractional quantity", { command_id: "c", type: "inventory.receive", payload: { location_id: "loc-a", sku: "sku-a", quantity: 1.5 } }],
    ["same from/to", { command_id: "c", type: "inventory.move", payload: { from_location_id: "loc-a", to_location_id: "loc-a", sku: "sku-a", quantity: 1 } }],
    ["zero delta", { command_id: "c", type: "inventory.adjust", payload: { location_id: "loc-a", sku: "sku-a", delta: 0, reason: "correction" } }],
    ["bad id", { command_id: "c", type: "inventory.receive", payload: { location_id: "LOC A; DROP", sku: "sku-a", quantity: 1 } }],
    ["not an object", "inventory.receive"],
  ])("rejects %s without throwing", (_name, input) => {
    const r = parseCommand(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("event contracts", () => {
  it("accepts a valid envelope", () => {
    expect(DomainEvent.safeParse(validEvent).success).toBe(true);
  });

  it("rejects payloads that do not match the event_type", () => {
    const wrong = { ...validEvent, event_type: "inventory.moved" };
    expect(DomainEvent.safeParse(wrong).success).toBe(false);
  });

  it("rejects non-UTC or imprecise timestamps", () => {
    expect(DomainEvent.safeParse({ ...validEvent, occurred_at: "2026-01-05T06:00:00+07:00" }).success).toBe(false);
  });

  it("registers a schema version for every event type", () => {
    for (const t of EVENT_TYPES) expect(EVENT_PAYLOADS[t].version).toBeGreaterThanOrEqual(1);
  });
});

describe("generated JSON Schemas", () => {
  it.each(Object.keys(SCHEMA_FILES))("data/schemas/%s is up to date (run `pnpm schemas:generate`)", (name) => {
    const onDisk = readFileSync(resolve(schemasDir, name), "utf8");
    expect(onDisk).toBe(renderJsonSchema(name as keyof typeof SCHEMA_FILES));
  });
});
