import { describe, expect, it } from "vitest";
import { robustnessVerdict } from "./robustness";
import {
  evidenceOf,
  MAX_PAIRS,
  mean,
  median,
  pairedStats,
  pairedSummary,
  roundForDisplay,
  sampleSd,
  T_975,
  tCritical975,
  type Pair,
  type PairedStats,
} from "./stats";

const pairs = (b: readonly number[], c: readonly number[]): Pair[] =>
  b.map((x, i) => ({ baseline: x, candidate: c[i] ?? null }));

// Student t density, independent of the table: Γ ratios for half-integer arguments are exact.
function gammaHalf(k: number): number {
  // Γ(k / 2) for integer k ≥ 1.
  let g = k % 2 === 0 ? 1 : Math.sqrt(Math.PI);
  for (let x = k % 2 === 0 ? 1 : 0.5; x < k / 2; x += 1) g *= x;
  return g;
}
function tCdf(t: number, df: number): number {
  const c = gammaHalf(df + 1) / (Math.sqrt(df * Math.PI) * gammaHalf(df));
  const pdf = (x: number) => c * (1 + (x * x) / df) ** (-(df + 1) / 2);
  const n = 20_000; // Simpson's rule on [0, t]
  const h = t / n;
  let s = pdf(0) + pdf(t);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * pdf(i * h);
  return 0.5 + (s * h) / 3;
}

describe("basic statistics (hand-calculated)", () => {
  it("mean, median, sample standard deviation", () => {
    expect(mean([2, 4, 9])).toBe(5);
    expect(mean([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    // Deviations from 3: −2, −1, 0, 1, 2 → Σ² = 10, / (5 − 1) = 2.5.
    expect(sampleSd([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(sampleSd([7])).toBeNull();
  });

  it("the t table matches the Student t distribution for every df it covers", () => {
    for (let df = 1; df < T_975.length; df++)
      expect(Math.abs(tCdf(tCritical975(df), df) - 0.975)).toBeLessThan(5e-5);
    expect(T_975[4]).toBe(2.7764);
    expect(T_975[19]).toBe(2.093);
    expect(() => tCritical975(0)).toThrow(RangeError);
    expect(() => tCritical975(30)).toThrow(RangeError);
  });
});

describe("paired summary", () => {
  it("a consistent reduction: mean, interval and relative change by hand", () => {
    // d = c − b = −1, −2, −3, −4, −5; mean −3; s = √2.5 = 1.581139; se = s/√5 = 0.707107;
    // t(0.975, 4) = 2.7764 → half-width 1.963211 → [−4.963211, −1.036789].
    const s = pairedSummary(pairs([10, 12, 14, 16, 18], [9, 10, 11, 12, 13]), "lower");
    expect(s).toMatchObject({
      n: 5,
      missing: 0,
      baseline_mean: 14,
      candidate_mean: 11,
      baseline_median: 14,
      candidate_median: 11,
      mean_diff: -3,
      median_diff: -3,
      sd_diff: 1.581,
      se_diff: 0.707,
      ci95: { low: -4.963, high: -1.037 },
      degenerate: false,
      relative_pct: -21.43, // −3 / 14
      seeds_better: 5,
      seeds_worse: 0,
      seeds_tied: 0,
      evidence: "better",
    });
  });

  it("direction: the same pairs are worse for a metric where higher is better", () => {
    const s = pairedSummary(pairs([10, 12, 14, 16, 18], [9, 10, 11, 12, 13]), "higher");
    expect(s.evidence).toBe("worse");
    expect([s.seeds_better, s.seeds_worse]).toEqual([0, 5]);
    expect(pairedSummary(pairs([1, 2, 3, 4, 5], [3, 4, 5, 6, 8]), "higher").evidence).toBe(
      "better",
    );
  });

  it("an interval that includes zero is no evidence either way", () => {
    // d = −2, 1, −1, 2, −3; mean −0.6; Σ(d − m)² = 17.2 → s = √4.3 = 2.073644; se = 0.927362;
    // half-width 2.7764 · 0.927362 = 2.574727 → [−3.174727, 1.974727].
    const s = pairedSummary(pairs([10, 10, 10, 10, 10], [8, 11, 9, 12, 7]), "lower");
    expect(s.ci95).toEqual({ low: -3.175, high: 1.975 });
    expect(s.evidence).toBe("no_evidence");
    expect([s.seeds_better, s.seeds_worse, s.seeds_tied]).toEqual([3, 2, 0]);
  });

  it("zero variance is flagged as a degenerate interval and is never evidence", () => {
    // d = −2 on every seed: a zero-width interval below zero, which the t method cannot support.
    const same = pairedSummary(pairs([5, 6, 7, 8, 9], [3, 4, 5, 6, 7]), "lower");
    expect(same).toMatchObject({
      sd_diff: 0,
      ci95: { low: -2, high: -2 },
      degenerate: true,
      evidence: "no_evidence",
      seeds_better: 5,
    });
    // The same pairs where higher is better, and constant increases: no evidence either way.
    expect(pairedSummary(pairs([5, 6, 7, 8, 9], [3, 4, 5, 6, 7]), "higher").evidence).toBe(
      "no_evidence",
    );
    expect(pairedSummary(pairs([5, 6, 7, 8, 9], [8, 9, 10, 11, 12]), "lower")).toMatchObject({
      ci95: { low: 3, high: 3 },
      degenerate: true,
      evidence: "no_evidence",
      seeds_worse: 5,
    });
    const identical = pairedSummary(pairs([5, 6, 7, 8, 9], [5, 6, 7, 8, 9]), "lower");
    expect(identical).toMatchObject({
      mean_diff: 0,
      ci95: { low: 0, high: 0 },
      degenerate: true,
      evidence: "no_evidence",
      seeds_tied: 5,
    });
  });

  it("differences equal up to floating-point error are degenerate, not a near-zero-width interval", () => {
    // 0.3 − 0.1, 0.7 − 0.5, … are all 0.2 in decimal, but differ by ~1e-16 in binary: a naive
    // sample SD of 1.2e-16 would give an interval of width ~3e-16 and claim "worse".
    const pairsOf = pairs([0.1, 0.5, 1.1, 2.2, 0.7], [0.3, 0.7, 1.3, 2.4, 0.9]);
    expect(sampleSd(pairsOf.map((p) => (p.candidate as number) - (p.baseline as number)))).not.toBe(
      0,
    );
    const s = pairedStats(pairsOf, "lower");
    expect(s).toMatchObject({ degenerate: true, sd_diff: 0, evidence: "no_evidence" });
    // Genuinely different differences, however small in display terms, are not degenerate.
    expect(
      pairedStats(pairs([10, 10, 10, 10, 10], [10.001, 10.002, 10.001, 10.002, 10.001]), "lower")
        .degenerate,
    ).toBe(false);
  });

  it("evidence ignores a degenerate interval, a short sample and informational metrics", () => {
    const below = { low: -3, high: -1 };
    expect(evidenceOf(below, "lower", 5, false)).toBe("better");
    expect(evidenceOf(below, "lower", 5, true)).toBe("no_evidence");
    expect(evidenceOf(below, "higher", 5, true)).toBe("no_evidence");
    expect(evidenceOf(below, "lower", 4, false)).toBe("no_evidence");
    expect(evidenceOf(null, "lower", 5, false)).toBe("no_evidence");
    expect(evidenceOf(below, "info", 5, false)).toBe("not_applicable");
  });

  it("display rounding is applied after evidence, and changes nothing but the digits", () => {
    const exact = pairedStats(pairs([10, 12, 14, 16, 18], [9, 10, 11, 12, 13]), "lower");
    expect(exact.ci95?.low).toBeCloseTo(-4.963211, 6);
    expect(exact.sd_diff).toBeCloseTo(Math.sqrt(2.5), 12);
    const shown = roundForDisplay(exact);
    expect(shown).toEqual(pairedSummary(pairs([10, 12, 14, 16, 18], [9, 10, 11, 12, 13]), "lower"));
    expect(shown).toMatchObject({ ci95: { low: -4.963, high: -1.037 }, relative_pct: -21.43 });
    expect(shown.evidence).toBe(exact.evidence);
  });

  it("no relative change against a zero or missing baseline", () => {
    expect(pairedSummary(pairs([0, 0, 0, 0, 0], [1, 2, 1, 2, 1]), "lower").relative_pct).toBeNull();
  });

  it("missing and non-finite observations are left out and counted, never averaged", () => {
    const s = pairedSummary(
      [
        { baseline: 10, candidate: 8 },
        { baseline: null, candidate: 8 },
        { baseline: 10, candidate: Number.NaN },
        { baseline: Number.POSITIVE_INFINITY, candidate: 1 },
        { baseline: 12, candidate: 9 },
      ],
      "lower",
    );
    expect(s).toMatchObject({ n: 2, missing: 3, mean_diff: -2.5, baseline_mean: 11 });
    for (const v of Object.values(s))
      if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
  });

  it("too few pairs: no interval below two, no evidence below five", () => {
    expect(pairedSummary(pairs([10], [8]), "lower")).toMatchObject({
      n: 1,
      sd_diff: null,
      ci95: null,
      evidence: "no_evidence",
    });
    const three = pairedSummary(pairs([10, 11, 12], [1, 2, 3]), "lower");
    expect(three.ci95?.high).toBeLessThan(0);
    expect(three.evidence).toBe("no_evidence");
    expect(pairedSummary([], "lower")).toMatchObject({ n: 0, mean_diff: null, ci95: null });
  });

  it("workload metrics are described, never judged", () => {
    const s = pairedSummary(pairs([10, 12, 14, 16, 18], [9, 10, 11, 12, 13]), "info");
    expect(s.evidence).toBe("not_applicable");
    expect([s.seeds_better, s.seeds_worse, s.seeds_tied]).toEqual([0, 0, 0]);
  });

  it("refuses more pairs than the t table covers", () => {
    expect(() => pairedSummary(pairs(Array(MAX_PAIRS + 1).fill(1), []), "lower")).toThrow(
      RangeError,
    );
  });
});

describe("robustness verdict", () => {
  const thresholds = { min_improvement_pct: 5, min_improvement_s: 2 };
  // The verdict takes the unrounded statistics (a display summary does not type-check).
  const summary = (b: number[], c: number[]): PairedStats => pairedStats(pairs(b, c), "lower");
  const reduction = summary([10, 12, 14, 16, 18], [9, 10, 11, 12, 13]); // −3 s, −21 %

  it("improved: interval below zero and the practical threshold met", () => {
    expect(robustnessVerdict(reduction, [], thresholds).verdict).toBe("improved");
  });

  it("statistically better but below the practical threshold is reported as such", () => {
    // d = −0.4, −0.5, −0.6, −0.5, −0.5 (mean −0.5 s): reliably better, far below 2 s.
    const small = summary([60, 60, 60, 60, 60], [59.6, 59.5, 59.4, 59.5, 59.5]);
    expect(small.ci95?.high).toBeLessThan(0);
    const v = robustnessVerdict(small, [], thresholds);
    expect(v.verdict).toBe("improved_below_threshold");
    expect(v.reasons.join(" ")).toContain("below the 5 % / 2 s practical threshold");
    // 3 s but only 1 % of a 300 s baseline: the percentage threshold also applies.
    const pct = summary([300, 301, 302, 303, 304], [297, 297.5, 299, 300.5, 301]);
    expect(robustnessVerdict(pct, [], thresholds).verdict).toBe("improved_below_threshold");
  });

  it("regressed when the interval is above zero; inconclusive when it includes zero", () => {
    const worse = summary([9, 10, 11, 12, 13], [10, 12, 14, 16, 18]);
    expect(robustnessVerdict(worse, [], thresholds).verdict).toBe("regressed");
    const mixed = summary([10, 10, 10, 10, 10], [8, 11, 9, 12, 7]);
    expect(robustnessVerdict(mixed, [], thresholds).verdict).toBe("inconclusive");
  });

  it("insufficient data below five valid pairs, even with a narrow interval", () => {
    const four = summary([10, 11, 12, 13], [1, 2, 3, 4]);
    expect(robustnessVerdict(four, [], thresholds).verdict).toBe("insufficient_data");
  });

  it("a hard-constraint failure on one seed overrides an improved average", () => {
    const v = robustnessVerdict(
      reduction,
      [{ index: 3, failed: ["Service level: 170 pallets, floor 177"], workload_diverged: true }],
      thresholds,
    );
    expect(v.verdict).toBe("constraint_failure");
    expect(v.reasons[1]).toContain("Seed 3: Service level");
    expect(v.reasons[1]).toContain("different demand");
    // The statistical reading is context, labelled as not the verdict.
    expect(v.reasons.at(-1)).toContain('would read "improved"');
  });

  it("a constant reduction on every seed is inconclusive, never improved", () => {
    // d = −2 s on five seeds: the interval is the point −2, not a statistical estimate.
    const v = robustnessVerdict(
      summary([50, 51, 52, 53, 54], [48, 49, 50, 51, 52]),
      [],
      thresholds,
    );
    expect(v.verdict).toBe("inconclusive");
    expect(v.reasons[0]).toContain("zero width");
    expect(v.reasons[1]).toContain("5 / 0 / 0");
    // Even far above both thresholds.
    const big = summary([60, 60, 60, 60, 60], [30, 30, 30, 30, 30]);
    expect(robustnessVerdict(big, [], thresholds).verdict).toBe("inconclusive");
  });

  it("a constant increase on every seed is inconclusive, never regressed", () => {
    const v = robustnessVerdict(
      summary([50, 51, 52, 53, 54], [53, 54, 55, 56, 57]),
      [],
      thresholds,
    );
    expect(v.verdict).toBe("inconclusive");
    expect(v.reasons[1]).toContain("0 / 5 / 0");
  });

  it("a constraint failure still overrides a degenerate reading; too few pairs stay insufficient", () => {
    const constant = summary([50, 51, 52, 53, 54], [48, 49, 50, 51, 52]);
    const v = robustnessVerdict(
      constant,
      [{ index: 2, failed: ["Service level: 170 pallets, floor 177"], workload_diverged: false }],
      thresholds,
    );
    expect(v.verdict).toBe("constraint_failure");
    expect(v.reasons.at(-1)).toContain('would read "inconclusive"');
    const fourConstant = summary([50, 51, 52, 53], [48, 49, 50, 51]);
    expect(fourConstant.degenerate).toBe(true);
    expect(robustnessVerdict(fourConstant, [], thresholds).verdict).toBe("insufficient_data");
  });
});

describe("verdict precision: decisions on unrounded values", () => {
  const thresholds = { min_improvement_pct: 5, min_improvement_s: 2 };
  // d = m + k·(−2, −1, 0, 1, 2): mean m; s = k·√2.5; half-width t(0.975, 4)·s/√5 = 1.963211·k.
  const spread = (base: number, m: number, k: number) =>
    pairs(
      [base, base, base, base, base],
      [-2, -1, 0, 1, 2].map((u) => base + m + k * u),
    );

  it("2 s threshold: exactly 2 s is met; 1.9996 s is not, although it displays as −2", () => {
    const at = pairedStats(spread(10, -2, 0.1), "lower");
    expect(at.mean_diff).toBeCloseTo(-2, 12);
    expect(robustnessVerdict(at, [], thresholds).verdict).toBe("improved");
    const under = pairedStats(spread(10, -1.9996, 0.1), "lower");
    expect(roundForDisplay(under).mean_diff).toBe(-2);
    const v = robustnessVerdict(under, [], thresholds);
    expect(v.verdict).toBe("improved_below_threshold");
    // The text shows enough digits not to contradict the decision.
    expect(v.reasons[1]).toContain("1.9996 s");
    expect(v.reasons[1]).not.toContain("2.0 s");
  });

  it("5 % threshold: exactly 5 % is met; 4.996 % is not, although it displays as −5 %", () => {
    // −2.5 s against a 50 s baseline is −5 %; against 50.04 s it is −4.996 %.
    const at = pairedStats(spread(50, -2.5, 0.1), "lower");
    expect(at.relative_pct).toBeCloseTo(-5, 12);
    expect(robustnessVerdict(at, [], thresholds).verdict).toBe("improved");
    const under = pairedStats(spread(50.04, -2.5, 0.1), "lower");
    expect(under.relative_pct).toBeCloseTo(-4.996003, 6);
    expect(roundForDisplay(under).relative_pct).toBe(-5);
    const v = robustnessVerdict(under, [], thresholds);
    expect(v.verdict).toBe("improved_below_threshold");
    expect(v.reasons[1]).toContain("4.996 %");
  });

  it("an interval ending just below zero is evidence, though it displays as 0", () => {
    // m = −1.9636, k = 1: high = −1.9636 + 1.963211 = −0.000389.
    const s = pairedStats(spread(100, -1.9636, 1), "lower");
    expect(s.ci95?.high).toBeLessThan(0);
    expect(s.ci95?.high).toBeGreaterThan(-0.0005);
    expect(roundForDisplay(s).ci95?.high).toBeCloseTo(0, 12);
    expect(s.evidence).toBe("better");
    // Verdict and evidence agree (before, the rounded bound read "includes zero").
    expect(robustnessVerdict(s, [], thresholds).verdict).toBe("improved_below_threshold");
  });

  it("an interval ending just above zero is no evidence, and no improvement", () => {
    // m = −1.9628: high = +0.000411, which displays as 0.
    const s = pairedStats(spread(100, -1.9628, 1), "lower");
    expect(s.ci95?.high).toBeGreaterThan(0);
    expect(roundForDisplay(s).ci95?.high).toBeCloseTo(0, 12);
    expect(s.evidence).toBe("no_evidence");
    expect(robustnessVerdict(s, [], thresholds).verdict).toBe("inconclusive");
  });

  it("an interval starting just above zero is a regression, though it displays as 0", () => {
    const s = pairedStats(spread(100, 1.9636, 1), "lower");
    expect(s.ci95?.low).toBeGreaterThan(0);
    expect(roundForDisplay(s).ci95?.low).toBeCloseTo(0, 12);
    expect(s.evidence).toBe("worse");
    expect(robustnessVerdict(s, [], thresholds).verdict).toBe("regressed");
  });

  it("the verdict always agrees with the primary metric's evidence", () => {
    const cases = [
      spread(10, -2, 0.1),
      spread(10, -1.9996, 0.1),
      spread(100, -1.9636, 1),
      spread(100, -1.9628, 1),
      spread(100, 1.9636, 1),
      spread(100, 0, 1),
      pairs([50, 51, 52, 53, 54], [48, 49, 50, 51, 52]),
      pairs([50, 51, 52, 53, 54], [53, 54, 55, 56, 57]),
    ];
    const expected = {
      better: ["improved", "improved_below_threshold"],
      worse: ["regressed"],
      no_evidence: ["inconclusive"],
    } as const;
    for (const p of cases) {
      const s = pairedStats(p, "lower");
      const allowed: readonly string[] = expected[s.evidence as keyof typeof expected];
      expect(allowed).toContain(robustnessVerdict(s, [], thresholds).verdict);
    }
  });
});
