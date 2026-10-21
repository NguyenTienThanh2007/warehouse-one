import { createScenario } from "@warehouse-one/simulation";
import { describe, expect, it } from "vitest";
import { qualityFromSearch } from "../world/view-store";
import {
  commandLog,
  formatSimClock,
  REJECTION_EXPLANATION,
  renderAlpha,
  scenarioFromSearch,
  stockSummary,
  summarizeCommand,
  useSimulation,
} from "./store";

describe("URL options", () => {
  it("accepts known scenarios and qualities only", () => {
    expect(scenarioFromSearch("?scenario=bench-1000")).toBe("bench-1000");
    expect(scenarioFromSearch("?scenario=../../etc")).toBeNull();
    expect(scenarioFromSearch("")).toBeNull();
    expect(qualityFromSearch("?quality=low")).toBe("low");
    expect(qualityFromSearch("?quality=ultra")).toBeNull();
  });
});

describe("simulation store", () => {
  it("starts on the showcase with its opening stock applied at tick 1", () => {
    const s = useSimulation.getState();
    expect(s.scenarioId).toBe("showcase");
    expect(s.tick).toBe(1);
    expect(stockSummary(s.config, s.inventory).units).toBeGreaterThan(0);
    expect(s.eventCount).toBeGreaterThan(0);
  });

  it("loads a scenario through the command path and clears the selection", () => {
    useSimulation.getState().select({ kind: "location", id: "loc-00-001" });
    useSimulation.getState().loadScenario("bench-300");
    const s = useSimulation.getState();
    expect(s.scenarioId).toBe("bench-300");
    expect(s.selection).toBeNull();
    expect(s.tick).toBe(1);
    expect(s.rejectionCount).toBe(0);
    expect(stockSummary(s.config, s.inventory).units).toBe(300);
    expect(s.config.simulation_id).toBe(createScenario("bench-300").config.simulation_id);
  });

  it("reset reloads the current scenario", () => {
    useSimulation.getState().loadScenario("empty");
    useSimulation.getState().stepOnce();
    useSimulation.getState().reset();
    const s = useSimulation.getState();
    expect(s.scenarioId).toBe("empty");
    expect(s.tick).toBe(0);
    expect(stockSummary(s.config, s.inventory)).toMatchObject({
      units: 0,
      occupied: 0,
      utilisation: 0,
    });
  });
});

describe("operator commands go through the real command path", () => {
  const sim = () => useSimulation.getState();
  const fresh = () => {
    sim().loadScenario("empty");
    if (!sim().paused) sim().togglePause();
  };

  it("queues a valid command, then records that the engine accepted it on the next tick", () => {
    fresh();
    const r = sim().submitCommand({
      type: "inventory.receive",
      payload: { location_id: "loc-00-001", sku: "sku-std-pallet", quantity: 2 },
    });
    expect(r.status).toBe("pending");
    // Paused: nothing applies until the next tick.
    expect(sim().state.ops!.pallets).toEqual({});
    sim().stepOnce();
    const done = sim().commands.find((c) => c.command_id === r.command_id)!;
    expect(done).toMatchObject({ status: "accepted", appliedTick: sim().tick });
    expect(Object.values(sim().state.ops!.pallets)).toHaveLength(2);
    // The command is in the replayable log, exactly as submitted.
    const logged = commandLog().find((l) => l.command.command_id === r.command_id);
    expect(logged?.command.type).toBe("inventory.receive");
  });

  it("explains business-rule rejections from the engine, without changing state", () => {
    fresh();
    const before = sim().stateHash;
    const r = sim().submitCommand({
      type: "order.create",
      payload: { lines: [{ sku: "sku-electronics", quantity: 3 }] },
    });
    sim().stepOnce();
    const done = sim().commands.find((c) => c.command_id === r.command_id)!;
    expect(done.status).toBe("rejected");
    expect(done.code).toBe("INSUFFICIENT_STOCK");
    expect(done.message).toMatch(/0 pallets available, 3 requested/);
    expect(REJECTION_EXPLANATION[done.code!]).toMatch(/Not enough free pallets/);
    expect(sim().rejectionCount).toBe(1);
    expect(sim().state.ops!.orders).toEqual({});
    // Only the clock moved: no order, truck or allocation was created.
    expect(sim().stateHash).not.toBe(before);
    expect(Object.keys(sim().state.ops!.trucks)).toEqual([]);
  });

  it("rejects schema-invalid input at submit, before it reaches the simulation", () => {
    fresh();
    const r = sim().submitCommand({
      type: "order.create",
      payload: { lines: [{ sku: "sku-electronics", quantity: 0 }] },
    });
    expect(r.status).toBe("rejected");
    expect(r.code).toBe("INVALID_COMMAND");
    expect(r.message).toMatch(/quantity/);
    sim().stepOnce();
    expect(commandLog().some((l) => l.command.command_id === r.command_id)).toBe(false);
  });

  it("keeps the outcome of orders after they leave operational state", () => {
    fresh();
    sim().submitCommand({
      type: "inventory.receive",
      payload: { location_id: "loc-00-001", sku: "sku-cold-chain", quantity: 1 },
    });
    sim().submitCommand({
      type: "order.create",
      payload: { lines: [{ sku: "sku-cold-chain", quantity: 1 }] },
    });
    sim().stepOnce();
    const order = Object.keys(sim().state.ops!.orders)[0]!;
    // A free dock is assigned at once, so picking starts and the order can no longer be cancelled.
    const cancel = sim().submitCommand({ type: "order.cancel", payload: { order_id: order } });
    sim().stepOnce();
    expect(sim().commands.find((c) => c.command_id === cancel.command_id)).toMatchObject({
      status: "rejected",
      code: "ORDER_NOT_CANCELLABLE",
    });
    for (let i = 0; i < 6000 && Object.keys(sim().state.ops!.orders).length > 0; i++)
      sim().stepOnce();
    expect(sim().state.ops!.orders).toEqual({});
    expect(sim().finishedOrders[0]).toMatchObject({ order_id: order, status: "shipped" });
    expect(sim().state.ops!.pallets).toEqual({});
  });

  it("tracks the previous tick for interpolation and shows the latest state when paused", () => {
    fresh();
    const t = sim().tick;
    sim().stepOnce();
    sim().stepOnce();
    expect(sim().state.tick).toBe(t + 2);
    expect(sim().prevState.tick).toBe(t + 1);
    expect(renderAlpha()).toBe(1);
  });

  it("describes commands in one line", () => {
    expect(
      summarizeCommand({
        type: "order.create",
        payload: { lines: [{ sku: "a", quantity: 2 }] },
      }),
    ).toBe("Order 2 × a");
    expect(
      summarizeCommand({
        type: "pallet.relocate",
        payload: { pallet_id: "p", to_location_id: "l" },
      }),
    ).toBe("Relocate p → l");
  });
});

describe("formatSimClock", () => {
  it("formats epoch + simulated time as UTC wall clock", () => {
    expect(formatSimClock("2026-01-05T06:00:00.000Z", 0)).toBe("06:00:00");
    expect(formatSimClock("2026-01-05T06:00:00.000Z", 3_723_000)).toBe("07:02:03");
  });
});

describe("software renderer detection", () => {
  it.each([
    [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      true,
    ],
    ["llvmpipe (LLVM 15.0.7, 256 bits)", true],
    ["Microsoft Basic Render Driver", true],
    ["ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)", false],
    ["ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)", false],
  ])("%s → %s", async (renderer, expected) => {
    const { isSoftwareRenderer } = await import("../world/view-store");
    expect(isSoftwareRenderer(renderer)).toBe(expected);
  });
});
