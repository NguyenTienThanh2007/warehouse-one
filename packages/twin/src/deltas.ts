import { METRICS, round, type FleetMetrics, type MetricInfo } from "./metrics";

/** One metric of a candidate next to the baseline, computed by the same rules for both. */
export interface MetricDelta {
  readonly key: MetricInfo["key"];
  readonly unit: MetricInfo["unit"];
  readonly better: MetricInfo["better"];
  readonly baseline: number | null;
  readonly candidate: number | null;
  /** candidate − baseline, in `unit`; null when either side has no value. */
  readonly abs: number | null;
  /** abs / baseline × 100; null when the baseline is 0 or missing (no meaningful ratio). */
  readonly pct: number | null;
  /** Whether the change goes the better way; null for workload metrics or missing values. */
  readonly improved: boolean | null;
}

export function delta(
  info: MetricInfo,
  baseline: number | null,
  candidate: number | null,
): MetricDelta {
  const abs = baseline === null || candidate === null ? null : round(candidate - baseline, 3);
  const pct =
    abs === null || !baseline ? null : round((abs / Math.abs(baseline as number)) * 100, 1);
  const improved =
    abs === null || info.better === "info" ? null : info.better === "lower" ? abs < 0 : abs > 0;
  return {
    key: info.key,
    unit: info.unit,
    better: info.better,
    baseline,
    candidate,
    abs,
    pct,
    improved,
  };
}

export function compareMetrics(baseline: FleetMetrics, candidate: FleetMetrics): MetricDelta[] {
  return METRICS.map((m) => delta(m, baseline[m.key], candidate[m.key]));
}
