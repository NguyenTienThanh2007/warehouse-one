/**
 * Paired statistics for multi-seed robustness evaluation (Phase 6.2, DEC-043). Pure functions,
 * no randomness: the same observations always give the same summary.
 *
 * Method: for each seed i the baseline and the candidate are simulated from the same start state,
 * giving a pair (b_i, c_i) and a paired difference d_i = c_i − b_i. The 95 % confidence interval
 * of the mean difference is the paired Student t interval, mean(d) ± t(0.975, n − 1) · s_d / √n,
 * with s_d the sample standard deviation (n − 1 denominator). It assumes the differences are
 * roughly normal; with 5–30 seeds a percentile bootstrap would under-cover, which is why it is not
 * used. The counts of seeds where the candidate was better, worse or tied are a distribution-free
 * view of the same pairs.
 */
import { round } from "./metrics";

/**
 * Two-sided 95 % critical values of Student's t, t(0.975, df), for df = 1…29 (index = df).
 * Published values (e.g. NIST/SEMATECH e-Handbook, table 1.3.6.7.2), four decimals; checked
 * against the t density by numerical integration in stats.test.ts.
 */
export const T_975: readonly number[] = [
  Number.NaN,
  12.7062,
  4.3027,
  3.1824,
  2.7764,
  2.5706,
  2.4469,
  2.3646,
  2.306,
  2.2622,
  2.2281,
  2.201,
  2.1788,
  2.1604,
  2.1448,
  2.1314,
  2.1199,
  2.1098,
  2.1009,
  2.093,
  2.086,
  2.0796,
  2.0739,
  2.0687,
  2.0639,
  2.0595,
  2.0555,
  2.0518,
  2.0484,
  2.0452,
];

/** The largest sample the t table covers (df = 29). */
export const MAX_PAIRS = T_975.length;

/** Fewer valid pairs than this give no verdict, whatever the interval says. */
export const MIN_PAIRS_FOR_VERDICT = 5;

export interface Pair {
  readonly baseline: number | null;
  readonly candidate: number | null;
}

export type Better = "lower" | "higher" | "info";

/** What the interval says about one metric, in the metric's own direction of improvement. */
export type Evidence = "better" | "worse" | "no_evidence" | "not_applicable";

export interface PairedSummary {
  /** Pairs where both values are finite numbers. */
  readonly n: number;
  /** Pairs left out because a value was missing (no transfer to measure) or not finite. */
  readonly missing: number;
  readonly baseline_mean: number | null;
  readonly candidate_mean: number | null;
  readonly baseline_median: number | null;
  readonly candidate_median: number | null;
  /** Mean of d = candidate − baseline. */
  readonly mean_diff: number | null;
  readonly median_diff: number | null;
  /** Sample standard deviation of d (n − 1); null below two pairs. */
  readonly sd_diff: number | null;
  /** Standard error of the mean difference, s_d / √n. */
  readonly se_diff: number | null;
  /** 95 % paired t interval of the mean difference; null below two pairs. */
  readonly ci95: { readonly low: number; readonly high: number } | null;
  /** Every difference is the same: the interval has zero width and its method does not apply. */
  readonly degenerate: boolean;
  /** Mean difference relative to the baseline mean, in %; null when that mean is not > 0. */
  readonly relative_pct: number | null;
  /** Seeds where the candidate was better, worse, or equal (in this metric's direction). */
  readonly seeds_better: number;
  readonly seeds_worse: number;
  readonly seeds_tied: number;
  readonly evidence: Evidence;
}

const finite = (x: number | null): x is number => x !== null && Number.isFinite(x);

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

/** Sample standard deviation (n − 1 denominator); null below two values. */
export function sampleSd(xs: readonly number[]): number | null {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (xs.length - 1));
}

/** t(0.975, df); throws outside the table rather than guessing. */
export function tCritical975(df: number): number {
  const t = T_975[df];
  if (!Number.isInteger(df) || df < 1 || t === undefined)
    throw new RangeError(`no 95 % t critical value for df = ${df} (supported: 1–29)`);
  return t;
}

/** Interval evidence in the metric's direction: entirely on the improving side, or the other. */
export function evidenceOf(
  ci: { readonly low: number; readonly high: number } | null,
  better: Better,
  n: number,
): Evidence {
  if (better === "info") return "not_applicable";
  if (ci === null || n < MIN_PAIRS_FOR_VERDICT) return "no_evidence";
  const below = ci.high < 0;
  const above = ci.low > 0;
  if (better === "lower") return below ? "better" : above ? "worse" : "no_evidence";
  return above ? "better" : below ? "worse" : "no_evidence";
}

/**
 * Summarise paired observations. Values are rounded for output (3 decimals); evidence and every
 * comparison are computed on the unrounded numbers.
 */
export function pairedSummary(pairs: readonly Pair[], better: Better): PairedSummary {
  if (pairs.length > MAX_PAIRS)
    throw new RangeError(`at most ${MAX_PAIRS} pairs are supported, got ${pairs.length}`);
  const valid = pairs.filter(
    (p): p is { baseline: number; candidate: number } => finite(p.baseline) && finite(p.candidate),
  );
  const n = valid.length;
  const b = valid.map((p) => p.baseline);
  const c = valid.map((p) => p.candidate);
  const d = valid.map((p) => p.candidate - p.baseline);
  const md = mean(d);
  const sd = sampleSd(d);
  const se = sd === null ? null : sd / Math.sqrt(n);
  const ci =
    md !== null && se !== null
      ? { low: md - tCritical975(n - 1) * se, high: md + tCritical975(n - 1) * se }
      : null;
  const bm = mean(b);
  const sign = better === "higher" ? -1 : 1; // a negative d is better for "lower" metrics
  let seedsBetter = 0;
  let seedsWorse = 0;
  for (const x of d) {
    if (x === 0) continue;
    if (sign * x < 0) seedsBetter += 1;
    else seedsWorse += 1;
  }
  const r = (x: number | null) => (x === null ? null : round(x, 3));
  return {
    n,
    missing: pairs.length - n,
    baseline_mean: r(bm),
    candidate_mean: r(mean(c)),
    baseline_median: r(median(b)),
    candidate_median: r(median(c)),
    mean_diff: r(md),
    median_diff: r(median(d)),
    sd_diff: r(sd),
    se_diff: r(se),
    ci95: ci && { low: round(ci.low, 3), high: round(ci.high, 3) },
    degenerate: sd === 0,
    relative_pct: md !== null && bm !== null && bm > 0 ? round((md / bm) * 100, 2) : null,
    seeds_better: better === "info" ? 0 : seedsBetter,
    seeds_worse: better === "info" ? 0 : seedsWorse,
    seeds_tied: better === "info" ? 0 : n - seedsBetter - seedsWorse,
    evidence: evidenceOf(ci, better, n),
  };
}
