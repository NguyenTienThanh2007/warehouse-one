/**
 * Pure presentation helpers for the AI workspace (unit-tested): labels, formatting of metrics and
 * deltas, and what each proposal status allows the operator to do.
 */
import type { MetricDelta, MetricKey, StandbyPlan } from "@warehouse-one/twin";
import { METRICS } from "@warehouse-one/twin";
import type { ProposalStatus } from "./api";

export const metricLabel = (key: string): string =>
  METRICS.find((m) => m.key === key)?.label ?? key;

export function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "—";
  if (unit === "s") return `${value.toFixed(1)} s`;
  if (unit === "km") return `${value.toFixed(2)} km`;
  return `${Math.round(value).toLocaleString("en-US")}`;
}

/** "−20.5 s (−25.0 %)"; "n/a" percentages when the baseline is zero or missing. */
export function formatDelta(d: Pick<MetricDelta, "abs" | "pct" | "unit">): string {
  if (d.abs === null) return "—";
  const sign = d.abs > 0 ? "+" : d.abs < 0 ? "−" : "±";
  const abs = Math.abs(d.abs);
  const value =
    d.unit === "s" ? `${abs.toFixed(1)} s` : d.unit === "km" ? `${abs.toFixed(2)} km` : `${abs}`;
  const pct =
    d.pct === null
      ? "n/a"
      : `${d.pct > 0 ? "+" : d.pct < 0 ? "−" : "±"}${Math.abs(d.pct).toFixed(1)} %`;
  return `${sign}${value} (${pct})`;
}

/** Statistics keep more decimals than single results: a mean of counts is not a count. */
export function formatStat(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "—";
  const digits = unit === "km" ? 2 : 1;
  return `${value.toFixed(digits)}${unit === "s" ? " s" : unit === "km" ? " km" : ""}`;
}

/** "−15.5 s", "+0.42 km", "±0.0 s". */
export function formatSignedStat(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${formatStat(Math.abs(value), unit)}`;
}

/** Most decimals a confidence-interval bound is shown with. */
export const BOUND_MAX_DIGITS = 6;

/**
 * A confidence-interval bound, signed. Compact like `formatSignedStat` ("−17.6 s"), except that a
 * non-zero bound is never shown as zero: its sign decides the evidence, so near zero it gets more
 * decimals, up to six ("−0.0004 s"), then "<0.000001". Only an exact zero reads "±0.0 s".
 */
export function formatBound(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return formatSignedStat(0, unit);
  const sign = value > 0 ? "+" : "−";
  const suffix = unit === "s" ? " s" : unit === "km" ? " km" : "";
  const abs = Math.abs(value);
  for (let digits = unit === "km" ? 2 : 1; digits <= BOUND_MAX_DIGITS; digits++) {
    const shown = abs.toFixed(digits);
    if (Number(shown) !== 0) return `${sign}${shown}${suffix}`;
  }
  return `${sign}<${(10 ** -BOUND_MAX_DIGITS).toFixed(BOUND_MAX_DIGITS)}${suffix}`;
}

/** "−17.6 s … −13.4 s"; "—" without an interval. */
export function formatInterval(
  ci: { readonly low: number; readonly high: number } | null,
  unit: string,
): string {
  return ci ? `${formatBound(ci.low, unit)} … ${formatBound(ci.high, unit)}` : "—";
}

/** Text tone of a delta: better, worse, or neutral (workload metrics and no change). */
export function deltaTone(
  d: Pick<MetricDelta, "improved" | "abs">,
): "better" | "worse" | "neutral" {
  if (d.improved === null || d.abs === 0 || d.abs === null) return "neutral";
  return d.improved ? "better" : "worse";
}

export const VERDICT_LABEL = {
  recommended: "Recommended",
  improves: "Improves",
  no_better: "No better",
  infeasible: "Infeasible",
} as const;

export const STATUS_LABEL: Record<ProposalStatus, string> = {
  generated: "Generated",
  validated: "Awaiting review",
  not_actionable: "Nothing to approve",
  invalid: "Failed validation",
  approved: "Approved",
  rejected: "Rejected",
  executing: "Applying",
  applied: "Applied",
  failed: "Apply failed",
  expired: "Expired (stale)",
  superseded: "Superseded",
};

export type Tone = "ok" | "warn" | "critical" | "info" | "muted";

export const STATUS_TONE: Record<ProposalStatus, Tone> = {
  generated: "muted",
  validated: "info",
  not_actionable: "muted",
  invalid: "critical",
  approved: "ok",
  rejected: "muted",
  executing: "warn",
  applied: "ok",
  failed: "critical",
  expired: "warn",
  superseded: "muted",
};

/** What the operator can do with a proposal in this status. */
export function allowedActions(status: ProposalStatus): {
  approve: boolean;
  reject: boolean;
  execute: boolean;
} {
  return {
    approve: status === "validated",
    reject: status === "validated" || status === "approved",
    execute: status === "approved",
  };
}

/** Trucks per place in a plan, in site order, depot last: "2 · Harbour terminal". */
export function planRows(
  plan: StandbyPlan,
  sites: readonly { site_id: string; site_name: string }[],
): { key: string; label: string; trucks: number }[] {
  const counts = new Map<string, number>();
  for (const a of plan.assignments)
    counts.set(a.site_id ?? "home", (counts.get(a.site_id ?? "home") ?? 0) + 1);
  const rows = sites
    .filter((s) => counts.has(s.site_id))
    .map((s) => ({ key: s.site_id, label: s.site_name, trucks: counts.get(s.site_id) as number }));
  if (counts.has("home"))
    rows.push({ key: "home", label: "Depot (home stalls)", trucks: counts.get("home") as number });
  return rows;
}

/** Simulated minutes of a horizon in 100 ms ticks. */
export const horizonMinutes = (ticks: number, tickMs = 100) =>
  Math.round((ticks * tickMs) / 60_000);

export const HORIZONS = [
  { ticks: 9_000, label: "15 min" },
  { ticks: 18_000, label: "30 min" },
  { ticks: 36_000, label: "60 min" },
] as const;

export const PRIMARY: MetricKey = "pickup_wait_s";
