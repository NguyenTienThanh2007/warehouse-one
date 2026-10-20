import { createScenario } from "@warehouse-one/simulation";
import { describe, expect, it } from "vitest";
import { qualityFromSearch } from "../world/view-store";
import { formatSimClock, scenarioFromSearch, stockSummary, useSimulation } from "./store";

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
