import { describe, expect, it } from "vitest";
import { PROPOSAL_STATUSES } from "./api";
import {
  allowedActions,
  deltaTone,
  formatBound,
  formatDelta,
  formatInterval,
  formatSignedStat,
  formatValue,
  planRows,
  STATUS_LABEL,
  STATUS_TONE,
} from "./view";

describe("AI workspace presentation", () => {
  it("formats deltas with units, signs and no invented percentages", () => {
    expect(formatDelta({ abs: -20.5, pct: -25, unit: "s" })).toBe("−20.5 s (−25.0 %)");
    expect(formatDelta({ abs: 1.25, pct: 8.3, unit: "km" })).toBe("+1.25 km (+8.3 %)");
    expect(formatDelta({ abs: 3, pct: null, unit: "pallets" })).toBe("+3 (n/a)");
    expect(formatDelta({ abs: 0, pct: 0, unit: "transfers" })).toBe("±0 (±0.0 %)");
    expect(formatDelta({ abs: null, pct: null, unit: "s" })).toBe("—");
    expect(formatValue(null, "s")).toBe("—");
    expect(formatValue(58, "s")).toBe("58.0 s");
  });

  it("colours a change by whether it is better, never workload metrics", () => {
    expect(deltaTone({ improved: true, abs: -3 })).toBe("better");
    expect(deltaTone({ improved: false, abs: 3 })).toBe("worse");
    expect(deltaTone({ improved: null, abs: 3 })).toBe("neutral");
    expect(deltaTone({ improved: false, abs: 0 })).toBe("neutral");
  });

  it("allows approval only before a decision and execution only after approval", () => {
    expect(allowedActions("validated")).toEqual({ approve: true, reject: true, execute: false });
    expect(allowedActions("approved")).toEqual({ approve: false, reject: true, execute: true });
    for (const s of [
      "not_actionable",
      "invalid",
      "rejected",
      "executing",
      "applied",
      "failed",
      "expired",
      "superseded",
    ] as const)
      expect(allowedActions(s)).toEqual({ approve: false, reject: false, execute: false });
  });

  it("labels every status", () => {
    for (const s of PROPOSAL_STATUSES) {
      expect(STATUS_LABEL[s]).toBeTruthy();
      expect(STATUS_TONE[s]).toBeTruthy();
    }
  });

  it("lists trucks per place in site order, depot last", () => {
    const rows = planRows(
      {
        assignments: [
          { vehicle_id: "a", site_id: "xd" },
          { vehicle_id: "b", site_id: null },
          { vehicle_id: "c", site_id: "term" },
          { vehicle_id: "d", site_id: "xd" },
        ],
      },
      [
        { site_id: "term", site_name: "Terminal" },
        { site_id: "xd", site_name: "Cross-dock" },
      ],
    );
    expect(rows.map((r) => [r.label, r.trucks])).toEqual([
      ["Terminal", 1],
      ["Cross-dock", 2],
      ["Depot (home stalls)", 1],
    ]);
  });

  describe("confidence-interval bounds (Phase 6.2)", () => {
    it("near zero, a bound keeps enough decimals to show its sign", () => {
      expect(formatBound(-0.000389, "s")).toBe("−0.0004 s"); // upper bound below zero
      expect(formatBound(0.000411, "s")).toBe("+0.0004 s"); // upper bound above zero
      expect(formatBound(0.000389, "s")).toBe("+0.0004 s"); // lower bound above zero
      expect(formatBound(-0.04, "s")).toBe("−0.04 s");
      expect(formatBound(0.0004, "km")).toBe("+0.0004 km");
      expect(formatBound(2e-7, "s")).toBe("+<0.000001 s");
      expect(formatBound(-2e-7, "")).toBe("−<0.000001");
    });

    it("an exact zero reads as zero; ordinary bounds keep the compact format", () => {
      expect(formatBound(0, "s")).toBe("±0.0 s");
      expect(formatBound(-0, "s")).toBe("±0.0 s");
      expect(formatBound(-17.575, "s")).toBe("−17.6 s");
      expect(formatBound(-13.425, "s")).toBe("−13.4 s");
      expect(formatBound(0.257, "km")).toBe("+0.26 km");
      expect(formatBound(-1.037, "")).toBe("−1.0");
      for (const v of [-17.575, -13.425, 0.257, 3])
        expect(formatBound(v, "s")).toBe(formatSignedStat(v, "s"));
      expect(formatBound(null, "s")).toBe("—");
    });

    it("an interval is two bounds, each formatted on its own", () => {
      expect(formatInterval({ low: -17.575, high: -13.425 }, "s")).toBe("−17.6 s … −13.4 s");
      expect(formatInterval({ low: -3.927, high: -0.000389 }, "s")).toBe("−3.9 s … −0.0004 s");
      expect(formatInterval({ low: 0.000389, high: 3.927 }, "s")).toBe("+0.0004 s … +3.9 s");
      expect(formatInterval(null, "s")).toBe("—");
    });
  });
});
