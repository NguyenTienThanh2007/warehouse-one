import { describe, expect, it } from "vitest";
import { PROPOSAL_STATUSES } from "./api";
import {
  allowedActions,
  deltaTone,
  formatDelta,
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
});
