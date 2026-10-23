import { describe, expect, it } from "vitest";
import { AVAILABLE_MODES, isAppMode, modeFromSearch, MODES, searchWithMode } from "./modes";

describe("product modes", () => {
  it("offers Explore, Operate and Analytics, in PRD order, and marks the rest as planned", () => {
    expect(MODES.map((m) => m.id)).toEqual(["explore", "operate", "build", "analytics", "ai"]);
    expect(MODES.filter((m) => m.status === "available").map((m) => m.id)).toEqual([
      ...AVAILABLE_MODES,
    ]);
  });

  it("describes planned modes accurately, without stale phase promises", () => {
    for (const m of MODES) {
      expect(m.summary.length).toBeGreaterThan(10);
      if (m.status !== "planned") continue;
      expect(m.detail).toMatch(/not (built|started)/i);
      expect(`${m.summary} ${m.detail} ${m.plan}`).not.toMatch(/Phase 2/);
    }
    const plan = Object.fromEntries(
      MODES.flatMap((m) => (m.status === "planned" ? [[m.id, m.plan]] : [])),
    );
    expect(plan).toEqual({ build: "Not scheduled", ai: "Phase 6" });
  });

  it("reads the mode from the URL, defaulting to Explore for anything unavailable", () => {
    expect(modeFromSearch("")).toBe("explore");
    expect(modeFromSearch("?mode=operate")).toBe("operate");
    expect(modeFromSearch("?scenario=showcase&mode=operate")).toBe("operate");
    expect(modeFromSearch("?mode=build")).toBe("explore");
    expect(modeFromSearch("?mode=analytics")).toBe("analytics");
    expect(modeFromSearch("?mode=nonsense")).toBe("explore");
    expect(isAppMode("ai")).toBe(false);
  });

  it("writes the mode into the URL and keeps the other parameters", () => {
    expect(searchWithMode("", "operate")).toBe("?mode=operate");
    expect(searchWithMode("?scenario=showcase", "operate")).toBe("?scenario=showcase&mode=operate");
    expect(searchWithMode("?scenario=showcase&mode=operate", "explore")).toBe("?scenario=showcase");
    expect(searchWithMode("?mode=operate", "explore")).toBe("");
  });
});

describe("mode state", () => {
  it("starts in Explore and records the mode that is opened", async () => {
    const { useView } = await import("../world/view-store");
    expect(useView.getState().mode).toBe("explore");
    useView.getState().setMode("operate");
    expect(useView.getState().mode).toBe("operate");
    useView.getState().setMode("explore");
    expect(useView.getState().mode).toBe("explore");
  });
});
