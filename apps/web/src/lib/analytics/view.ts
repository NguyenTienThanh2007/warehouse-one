/**
 * Pure presentation helpers for the analytics dashboard (no React, tested in view.test.ts).
 * Business times are simulated; ages are wall clock. Neither is ever presented as the other.
 */
import type { AnalyticsStatus, RunSummary } from "./api";

/** A simulated duration: "45 s", "6 min 20 s", "2 h 05 min"; "—" when there is no value. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** A wall-clock age: "just now", "4 min ago", "3 h ago", "2 d ago". */
export function formatAge(seconds: number): string {
  if (seconds < 45) return "just now";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** 1,284 · 12.9K · 4.2M (proportional figures for tiles). */
export function compact(n: number): string {
  if (Math.abs(n) < 10_000) return n.toLocaleString("en-US");
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "06:04:30" of a business (simulated) timestamp, in UTC like the simulation clock. */
export function clock(iso: string): string {
  return iso.slice(11, 19);
}

/** "2026-01-05 06:04 UTC". */
export function stamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export type Tone = "ok" | "info" | "warning" | "critical";

export interface Banner {
  tone: Tone;
  title: string;
  lines: string[];
}

/** What the dashboard says about the published data before showing any of it. */
export function banners(s: AnalyticsStatus): Banner[] {
  const out: Banner[] = [];
  // Also when nothing is published yet ("empty"): a failing pipeline is why nothing appears.
  if (s.state === "degraded" || !s.pipeline.healthy) {
    out.push({
      tone: "critical",
      title: s.snapshot
        ? "Pipeline problem: these figures are the last published snapshot"
        : "Pipeline problem: nothing can be published until it is fixed",
      lines: s.pipeline.problems,
    });
  }
  if (s.freshness?.is_stale) {
    out.push({
      tone: "warning",
      title: "Stale snapshot",
      lines: [
        `Published ${formatAge(s.freshness.age_seconds)}; snapshots older than ${Math.round(
          s.freshness.stale_after_seconds / 3600,
        )} h are stale. Figures may be out of date.`,
      ],
    });
  }
  if (s.freshness && s.freshness.events_recorded_after > 0) {
    out.push({
      tone: "info",
      title: "Newer events are not included yet",
      lines: [
        `${s.freshness.events_recorded_after.toLocaleString("en-US")} events were recorded after this snapshot was built; the next pipeline refresh publishes them.`,
      ],
    });
  }
  return out;
}

export type WindowPreset = "run" | "first-hour" | "last-hour" | "custom";

/** Window bounds (ISO, simulated time) for a preset; `undefined` means the run's own edge. */
export function presetWindow(
  preset: WindowPreset,
  run: Pick<RunSummary, "business_from" | "business_to">,
  custom?: { fromMin: number; toMin: number },
): { from?: string; to?: string } {
  const start = Date.parse(run.business_from);
  const end = Date.parse(run.business_to);
  const iso = (t: number) => new Date(t).toISOString();
  switch (preset) {
    case "run":
      return {};
    case "first-hour":
      return end - start <= 3_600_000 ? {} : { from: iso(start), to: iso(start + 3_600_000) };
    case "last-hour":
      return end - start <= 3_600_000 ? {} : { from: iso(end - 3_600_000) };
    case "custom": {
      const c = custom ?? { fromMin: 0, toMin: Math.ceil((end - start) / 60_000) };
      return { from: iso(start + c.fromMin * 60_000), to: iso(start + c.toMin * 60_000) };
    }
  }
}

/** The `n` largest entries, the rest folded into "Other" (never a generated 9th colour). */
export function topWithOther(
  items: readonly { key: string; value: number }[],
  n: number,
): { key: string; value: number }[] {
  const sorted = [...items].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  if (sorted.length <= n) return sorted;
  const rest = sorted.slice(n - 1).reduce((t, i) => t + i.value, 0);
  return [...sorted.slice(0, n - 1), { key: "Other", value: rest }];
}

/** A short label for a run in the selector. */
export function runLabel(r: RunSummary): string {
  const scenario = r.scenario_id ?? "unnamed run";
  return `${scenario} · ${r.simulation_id.slice(0, 8)} · ${formatDuration(r.simulated_span_ms)} · ${compact(r.events)} events`;
}
