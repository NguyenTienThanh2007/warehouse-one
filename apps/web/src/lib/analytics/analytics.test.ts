import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalyticsStatus, RunAnalytics, RunList } from "./api";
import { banners, compact, formatAge, formatDuration, presetWindow, topWithOther } from "./view";

/** Responses captured from the real analytics API (tests/e2e/fixtures/analytics). */
const dir = resolve(__dirname, "../../../../../tests/e2e/fixtures/analytics");
const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(dir, name), "utf8"));

describe("analytics API contract", () => {
  it("parses every captured API response with the client's schemas", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      const schema = f.startsWith("status")
        ? AnalyticsStatus
        : f === "runs.json"
          ? RunList
          : RunAnalytics;
      const r = schema.safeParse(fixture(f));
      expect(r.success, `${f}: ${r.success ? "" : JSON.stringify(r.error.issues[0])}`).toBe(true);
    }
  });

  it("rejects a response that drifted from the contract", () => {
    const run = fixture("run-operations.json") as { kpis: Record<string, unknown> };
    run.kpis.events = "197";
    expect(RunAnalytics.safeParse(run).success).toBe(false);
    expect(AnalyticsStatus.safeParse({ state: "live" }).success).toBe(false);
  });

  it("series and breakdowns reconcile with the KPIs in a real response", () => {
    for (const f of ["run-operations.json", "run-network.json", "run-operations-window.json"]) {
      const a = RunAnalytics.parse(fixture(f));
      expect(a.series.reduce((n, p) => n + p.events, 0)).toBe(a.kpis.events);
      expect(a.events_by_type.reduce((n, e) => n + e.value, 0)).toBe(a.kpis.events);
      expect(a.series.reduce((n, p) => n + p.tasks_completed, 0)).toBe(a.kpis.tasks_completed);
      expect(a.tasks_by_type.reduce((n, t) => n + t.completed, 0)).toBe(a.kpis.tasks_completed);
      expect(a.series).toHaveLength(a.window.buckets);
    }
  });
});

describe("presentation helpers", () => {
  it("formats simulated durations and wall-clock ages distinctly", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(380_000)).toBe("6 min 20 s");
    expect(formatDuration(7_500_000)).toBe("2 h 05 min");
    expect(formatAge(10)).toBe("just now");
    expect(formatAge(600)).toBe("10 min ago");
    expect(formatAge(5 * 3600)).toBe("5 h ago");
    expect(compact(1284)).toBe("1,284");
    expect(compact(12_900)).toBe("12.9K");
  });

  it("explains degraded, stale and incomplete snapshots before showing figures", () => {
    expect(banners(AnalyticsStatus.parse(fixture("status-fresh.json")))).toEqual([]);
    const stale = banners(AnalyticsStatus.parse(fixture("status-stale.json")));
    expect(stale.map((b) => b.tone)).toEqual(["warning"]);
    expect(stale[0]?.lines[0]).toMatch(/^Published 5 h ago/);
    const degraded = banners(AnalyticsStatus.parse(fixture("status-degraded.json")));
    expect(degraded[0]?.tone).toBe("critical");
    expect(degraded[0]?.title).toMatch(/last published snapshot/);
    expect(degraded[0]?.lines.join(" ")).toMatch(/latest reconciliation failed/);
  });

  it("explains a failing pipeline even before anything was published", () => {
    // Captured before any reconciliation or heartbeat: the API reports "empty", not "degraded".
    const empty = AnalyticsStatus.parse(fixture("status-empty.json"));
    expect(empty.state).toBe("empty");
    expect(banners(empty)).toEqual([
      {
        tone: "critical",
        title: "Pipeline problem: nothing can be published until it is fixed",
        lines: empty.pipeline.problems,
      },
    ]);
    // A healthy pipeline with nothing published yet is a plain empty state.
    expect(
      banners({ ...empty, pipeline: { ...empty.pipeline, healthy: true, problems: [] } }),
    ).toEqual([]);
  });

  it("turns window presets into simulated-time bounds", () => {
    const run = {
      business_from: "2026-01-05T06:00:00.000Z",
      business_to: "2026-01-05T09:30:00.000Z",
    };
    expect(presetWindow("run", run)).toEqual({});
    expect(presetWindow("first-hour", run)).toEqual({
      from: "2026-01-05T06:00:00.000Z",
      to: "2026-01-05T07:00:00.000Z",
    });
    expect(presetWindow("last-hour", run)).toEqual({ from: "2026-01-05T08:30:00.000Z" });
    expect(presetWindow("custom", run, { fromMin: 15, toMin: 45 })).toEqual({
      from: "2026-01-05T06:15:00.000Z",
      to: "2026-01-05T06:45:00.000Z",
    });
    // A run shorter than an hour: the hour presets are the whole run.
    const short = { business_from: run.business_from, business_to: "2026-01-05T06:08:00.000Z" };
    expect(presetWindow("first-hour", short)).toEqual({});
  });

  it("folds the tail into Other instead of inventing more colours", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ key: `t${i}`, value: 10 - i }));
    const top = topWithOther(items, 6);
    expect(top).toHaveLength(6);
    expect(top.at(-1)).toEqual({ key: "Other", value: 5 + 4 + 3 + 2 + 1 });
    expect(top.reduce((n, i) => n + i.value, 0)).toBe(55);
  });
});
