"use client";

import {
  SEED_TIERS,
  type MetricSummary,
  type RobustnessEvaluation,
  type RobustnessVerdict,
} from "@warehouse-one/twin";
import { useEffect, useState } from "react";
import { useTwin, type RobustnessState } from "@/lib/twin/store";
import { horizonMinutes, type Tone } from "@/lib/twin/view";
import { ExecutionBadge } from "./evaluation";
import { Badge, Button, Panel } from "./parts";

/**
 * Multi-seed robustness validation of one candidate (Phase 6.2, DEC-043). Advisory: computed in
 * this browser, not stored with the proposal, and never a substitute for approval.
 */

export const ROBUSTNESS_LABEL: Record<RobustnessVerdict, string> = {
  improved: "Robust improvement",
  improved_below_threshold: "Reliably better, below the practical threshold",
  inconclusive: "Inconclusive",
  regressed: "Regression",
  constraint_failure: "Hard constraint failed",
  insufficient_data: "Insufficient data",
};

const ROBUSTNESS_TONE: Record<RobustnessVerdict, Tone> = {
  improved: "ok",
  improved_below_threshold: "info",
  inconclusive: "muted",
  regressed: "critical",
  constraint_failure: "critical",
  insufficient_data: "warn",
};

const STAGE_LABEL = {
  validating: "Validating the snapshot and the plans",
  simulating: "Simulating both plans on every seed",
  aggregating: "Computing paired statistics",
  done: "Finishing",
} as const;

/** Statistics keep more decimals than single results: a mean of counts is not a count. */
function stat(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "—";
  const digits = unit === "km" ? 2 : 1;
  return `${value.toFixed(digits)}${unit === "s" ? " s" : unit === "km" ? " km" : ""}`;
}

function signed(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${stat(Math.abs(value), unit)}`;
}

const EVIDENCE_TEXT = {
  better: "text-ok-400",
  worse: "text-critical-400",
  no_evidence: "text-fog-200",
  not_applicable: "text-fog-400",
} as const;

const EVIDENCE_LABEL = {
  better: "reliably better",
  worse: "reliably worse",
  no_evidence: "no clear difference",
  not_applicable: "workload",
} as const;

export function RobustnessPanel() {
  const ready = useTwin((s) => s.evaluation.kind === "done");
  const hasSnapshot = useTwin(
    (s) => s.evaluation.kind === "done" && s.evaluation.snapshot !== null,
  );
  const horizon = useTwin((s) =>
    s.evaluation.kind === "done" ? s.evaluation.result.options.horizon_ticks : 0,
  );
  const candidate = useTwin((s) =>
    s.evaluation.kind === "done"
      ? (s.evaluation.result.candidates.find((c) => c.candidate_id === s.selected) ?? null)
      : null,
  );
  // Seconds per simulation measured by the evaluation on screen, for the cost estimate.
  const perSimMs = useTwin((s) =>
    s.evaluation.kind === "done" && s.evaluation.run && s.evaluation.result.search.simulations > 0
      ? s.evaluation.run.elapsedMs / s.evaluation.result.search.simulations
      : null,
  );
  // Only the progress view follows progress; the panel re-renders when the state's kind changes.
  const kind = useTwin((s) => s.robustness.kind);
  const done = useTwin((s) => (s.robustness.kind === "done" ? s.robustness : null));
  const seeds = useTwin((s) => s.seedCount);
  const { setSeedCount, validateRobustness, cancelRobustness } = useTwin.getState();
  if (!ready) return null;
  const running = kind === "running";
  const usable = candidate !== null && candidate.feasible && candidate.metrics !== null;
  const simulations = 2 * seeds;
  return (
    <Panel
      title="Robustness across seeds"
      subtitle="Does the selected plan keep beating the plan in effect when the future plays out differently? Both plans are simulated again from the same snapshot on several seeded futures, as pairs, and compared with a 95 % paired t interval."
      aside={<Badge tone="warn">Advisory · computed in this browser · not stored</Badge>}
      testid="twin-robustness"
    >
      {!hasSnapshot ? (
        <p className="text-xs text-fog-200" data-testid="twin-robustness-unavailable">
          Needs the snapshot this evaluation started from: available for evaluations run in this
          browser session, not for proposals loaded from the API.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[11px] text-fog-400">
              Seeds
              <select
                className="mt-1 block rounded-md border border-white/10 bg-ink-850 px-2 py-1.5 text-xs text-fog-50"
                value={seeds}
                onChange={(e) => setSeedCount(Number(e.target.value))}
                disabled={running}
                data-testid="twin-seeds"
              >
                {SEED_TIERS.map((t) => (
                  <option key={t.id} value={t.seeds}>
                    {t.label} · {t.seeds} seeds
                  </option>
                ))}
              </select>
            </label>
            <Button
              testid="twin-validate"
              onClick={() => void validateRobustness()}
              disabled={running || !usable}
            >
              {running ? "Validating…" : "Validate across seeds"}
            </Button>
            {running && (
              <Button variant="secondary" onClick={cancelRobustness} testid="twin-validate-cancel">
                Cancel
              </Button>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-4 text-fog-400" data-testid="twin-robustness-cost">
            {usable ? (
              <>
                Validates <span className="text-fog-200">{candidate.label}</span>: {simulations}{" "}
                simulations of {horizonMinutes(horizon)} simulated minutes (
                {(simulations * horizon).toLocaleString("en-US")} ticks)
                {perSimMs !== null &&
                  `, about ${Math.max(1, Math.round((perSimMs * simulations) / 1000))} s at the speed of the evaluation above`}
                .
              </>
            ) : (
              "Select a feasible candidate plan above to validate it."
            )}
          </p>
          {running && <RobustnessProgressView />}
          {kind === "cancelled" && (
            <p
              className="mt-3 text-xs text-fog-200"
              data-testid="twin-robustness-cancelled"
              role="status"
            >
              Validation cancelled: no verdict exists for it, and nothing was stored.
            </p>
          )}
          {done && (
            <RobustnessResult
              result={done.result}
              run={done.run}
              selectedId={candidate?.candidate_id ?? null}
            />
          )}
        </>
      )}
    </Panel>
  );
}

function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, now - startedAt);
}

function RobustnessProgressView() {
  const r = useTwin((s) => s.robustness);
  if (r.kind !== "running") return null;
  return <Running r={r} />;
}

function Running({ r }: { r: Extract<RobustnessState, { kind: "running" }> }) {
  const elapsed = useElapsed(r.startedAt);
  const p = r.progress;
  const pct = Math.round((p?.fraction ?? 0) * 100);
  const done = p?.seeds_done ?? 0;
  const runningSeeds = p?.seeds_running ?? 0;
  return (
    <div
      className="mt-3"
      data-testid="twin-robustness-progress"
      data-stage={p?.stage ?? "starting"}
      data-mode={r.mode}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-fog-400">
        <span className="text-fog-200" aria-live="polite" data-testid="twin-robustness-stage">
          {p ? STAGE_LABEL[p.stage] : "Starting"}
        </span>
        <ExecutionBadge mode={r.mode} />
      </div>
      <div
        className="mt-1 h-1.5 rounded-full bg-ink-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Validation progress"
      >
        <div
          className="h-1.5 origin-left rounded-full bg-data-400 transition-transform"
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
      <div className="mt-1 flex flex-wrap justify-between gap-2 text-[11px] text-fog-400">
        <span data-testid="twin-robustness-count">
          {done} of {r.seeds} seeds done · {runningSeeds} running ·{" "}
          {Math.max(0, r.seeds - done - runningSeeds)} pending
        </span>
        <span className="tabular-nums">
          {pct} % · {(elapsed / 1000).toFixed(0)} s
        </span>
      </div>
    </div>
  );
}

function RobustnessResult({
  result,
  run,
  selectedId,
}: {
  result: RobustnessEvaluation;
  run: Extract<RobustnessState, { kind: "done" }>["run"];
  selectedId: string | null;
}) {
  const primary = result.metrics.find((m) => m.key === result.primary) as MetricSummary;
  return (
    <div
      className="mt-3 flex flex-col gap-3"
      data-testid="twin-robustness-result"
      data-verdict={result.verdict}
      data-robustness-id={result.robustness_id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={ROBUSTNESS_TONE[result.verdict]} testid="twin-robustness-verdict">
          {ROBUSTNESS_LABEL[result.verdict]}
        </Badge>
        <span className="text-[11px] text-fog-400">
          {result.candidate.label} vs the plan in effect · {result.seeds.count} seeds ·{" "}
          {horizonMinutes(result.options.horizon_ticks)} simulated minutes each
        </span>
        {selectedId !== result.candidate.candidate_id && (
          <Badge tone="muted">Another plan is selected now</Badge>
        )}
      </div>
      <ul
        className="list-disc space-y-1 pl-4 text-xs text-fog-200"
        data-testid="twin-robustness-reasons"
      >
        {result.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
        {result.tradeoffs.map((t) => (
          <li key={t} className="text-warn-400" data-testid="twin-robustness-tradeoff">
            Trade-off: {t}
          </li>
        ))}
      </ul>
      <IntervalChart result={result} primary={primary} />
      <MetricTable metrics={result.metrics} />
      <SeedTable result={result} />
      <details className="text-[11px] text-fog-400" data-testid="twin-robustness-method">
        <summary className="cursor-pointer font-semibold text-fog-200">
          Method, reproducibility and limits
        </summary>
        <dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt>Method</dt>
          <dd className="text-fog-200">
            {result.method.id} v{result.method.version}: {result.method.description}
          </dd>
          <dt>Seeds</dt>
          <dd className="text-fog-200" data-testid="twin-robustness-seed-info">
            {result.seeds.count} from root seed <code>{result.seeds.root_seed}</code>:{" "}
            {result.seeds.derivation}
          </dd>
          <dt>Discovery</dt>
          <dd className="text-fog-200">
            Evaluation {result.discovery.evaluation_id.slice(0, 8)} on the live random stream, which
            no validation seed reuses
          </dd>
          <dt>Source</dt>
          <dd className="text-fog-200">
            Tick {result.source.tick.toLocaleString("en-US")} · state{" "}
            {result.source.state_hash.slice(0, 12)} · engine {result.source.engine_version}
          </dd>
          <dt>Pairing</dt>
          <dd className="text-fog-200" data-testid="twin-robustness-workload">
            {result.workload.note}
          </dd>
          <dt>Computed</dt>
          <dd className="flex flex-wrap items-center gap-2 text-fog-200">
            <ExecutionBadge mode={run.mode} workers={run.workers} />
            <span data-testid="twin-robustness-duration">
              in {(run.elapsedMs / 1000).toFixed(1)} s · id {result.robustness_id.slice(0, 8)}
            </span>
          </dd>
        </dl>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {result.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
      <p className="text-[11px] text-fog-400" data-testid="twin-robustness-advisory">
        Advisory evidence only: it does not approve anything. Approval stays with you, and the API
        still validates the plan before it can be applied.
      </p>
    </div>
  );
}

/** Paired differences in mean pickup wait: one dot per seed, the 95 % interval, zero and the
 * practical threshold. Left of zero is better. */
function IntervalChart({
  result,
  primary,
}: {
  result: RobustnessEvaluation;
  primary: MetricSummary;
}) {
  const deltas = result.per_seed
    .map((s) => s.deltas[result.primary])
    .filter((d): d is number => d !== null);
  const threshold = -result.options.min_improvement_s;
  const ci = primary.ci95;
  const values = [0, threshold, ...deltas, ...(ci ? [ci.low, ci.high] : [])];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(1, (hi - lo) * 0.08);
  const min = lo - pad;
  const max = hi + pad;
  const W = 560;
  const x = (v: number) => ((v - min) / (max - min)) * (W - 20) + 10;
  const summary = ci
    ? `Change in mean pickup wait per seed; 95 % interval ${ci.low} to ${ci.high} s, mean ${primary.mean_diff} s, zero at ${0}, practical threshold at ${threshold} s.`
    : "Not enough seeds with a value for an interval.";
  return (
    <figure data-testid="twin-robustness-ci" data-low={ci?.low} data-high={ci?.high}>
      <figcaption className="text-[11px] text-fog-400">
        Change in mean pickup wait per seed (candidate − baseline, s). Left of zero is better; the
        bar is the 95 % interval of the mean change.
      </figcaption>
      <svg viewBox={`0 0 ${W} 64`} className="mt-1 w-full" role="img" aria-label={summary}>
        <line x1={x(0)} x2={x(0)} y1={6} y2={58} className="stroke-fog-400" strokeWidth={1} />
        <line
          x1={x(threshold)}
          x2={x(threshold)}
          y1={6}
          y2={58}
          className="stroke-ok-400"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <text x={x(0) + 3} y={12} className="fill-fog-400 text-[9px]">
          0
        </text>
        <text x={x(threshold) + 3} y={12} className="fill-ok-400 text-[9px]">
          −{result.options.min_improvement_s} s
        </text>
        {deltas.map((d, i) => (
          <circle
            key={i}
            cx={x(d)}
            cy={22 + (i % 5) * 3}
            r={2.5}
            className="fill-data-300"
            opacity={0.7}
          />
        ))}
        {ci && (
          <g className="text-signal-400">
            <line
              x1={x(ci.low)}
              x2={x(ci.high)}
              y1={48}
              y2={48}
              stroke="currentColor"
              strokeWidth={3}
            />
            <line
              x1={x(ci.low)}
              x2={x(ci.low)}
              y1={43}
              y2={53}
              stroke="currentColor"
              strokeWidth={2}
            />
            <line
              x1={x(ci.high)}
              x2={x(ci.high)}
              y1={43}
              y2={53}
              stroke="currentColor"
              strokeWidth={2}
            />
            {primary.mean_diff !== null && (
              <circle cx={x(primary.mean_diff)} cy={48} r={4} fill="currentColor" />
            )}
          </g>
        )}
      </svg>
      {primary.degenerate && (
        <p className="text-[11px] text-warn-400">
          Every seed gave the same difference: the interval has zero width and is not a statistical
          estimate.
        </p>
      )}
    </figure>
  );
}

function MetricTable({ metrics }: { metrics: readonly MetricSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-[640px] text-left text-[11px]"
        data-testid="twin-robustness-metrics"
      >
        <caption className="sr-only">Paired statistics per metric across seeds</caption>
        <thead className="text-fog-400">
          <tr>
            <th scope="col" className="py-1 pr-2 font-medium">
              Metric
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">
              n
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">
              Baseline mean / median
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">
              Candidate mean / median
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">
              Mean change · sd
            </th>
            <th scope="col" className="py-1 pr-2 text-right font-medium">
              95 % interval
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Evidence
            </th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => (
            <tr
              key={m.key}
              className="border-t border-white/5"
              data-testid="twin-robustness-metric"
              data-key={m.key}
              data-evidence={m.evidence}
            >
              <th
                scope="row"
                className={`py-1 pr-2 font-normal ${m.better === "info" ? "text-fog-400" : "text-fog-200"}`}
              >
                {m.label}
              </th>
              <td className="py-1 pr-2 text-right text-fog-200 tabular-nums">
                {m.n}
                {m.missing ? ` (+${m.missing} n/a)` : ""}
              </td>
              <td className="py-1 pr-2 text-right text-fog-50 tabular-nums">
                {stat(m.baseline_mean, m.unit)} / {stat(m.baseline_median, m.unit)}
              </td>
              <td className="py-1 pr-2 text-right text-fog-50 tabular-nums">
                {stat(m.candidate_mean, m.unit)} / {stat(m.candidate_median, m.unit)}
              </td>
              <td className="py-1 pr-2 text-right text-fog-50 tabular-nums">
                {signed(m.mean_diff, m.unit)}
                {m.relative_pct !== null && ` (${signed(m.relative_pct, "")} %)`}
                <span className="text-fog-400"> · sd {stat(m.sd_diff, m.unit)}</span>
              </td>
              <td className="py-1 pr-2 text-right text-fog-200 tabular-nums">
                {m.ci95 ? `${signed(m.ci95.low, m.unit)} … ${signed(m.ci95.high, m.unit)}` : "—"}
              </td>
              <td className={`py-1 text-right ${EVIDENCE_TEXT[m.evidence]}`}>
                {EVIDENCE_LABEL[m.evidence]}
                {m.better !== "info" && ` · ${m.seeds_better}/${m.seeds_worse}/${m.seeds_tied}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-fog-400">
        Change = candidate − baseline, paired by seed. Evidence counts are seeds better / worse /
        tied. Grey rows describe the workload, which can differ between plans (see Pairing below).
      </p>
    </div>
  );
}

function SeedTable({ result }: { result: RobustnessEvaluation }) {
  return (
    <details className="text-[11px]" data-testid="twin-robustness-seeds">
      <summary className="cursor-pointer font-semibold text-fog-200">
        Every seed ({result.per_seed.length}; {result.per_seed.filter((s) => !s.passed).length} with
        a failed hard constraint)
      </summary>
      <div className="mt-2 max-h-72 overflow-auto">
        <table className="w-full min-w-[620px] text-left">
          <thead className="sticky top-0 bg-ink-900 text-fog-400">
            <tr>
              <th scope="col" className="py-1 pr-2 font-medium">
                Seed
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">
                Baseline wait
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">
                Candidate wait
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">
                Change
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">
                Empty km Δ
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">
                Pallets delivered Δ
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">
                Pallets planned Δ
              </th>
              <th scope="col" className="py-1 font-medium">
                Hard constraints
              </th>
            </tr>
          </thead>
          <tbody>
            {result.per_seed.map((s) => (
              <tr
                key={s.index}
                className="border-t border-white/5"
                data-testid="twin-robustness-seed"
                data-passed={s.passed}
              >
                <th scope="row" className="py-1 pr-2 font-normal text-fog-200" title={s.seed}>
                  {s.index}
                </th>
                <td className="py-1 pr-2 text-right text-fog-50 tabular-nums">
                  {stat(s.baseline.metrics.pickup_wait_s, "s")}
                </td>
                <td className="py-1 pr-2 text-right text-fog-50 tabular-nums">
                  {stat(s.candidate.metrics.pickup_wait_s, "s")}
                </td>
                <td className="py-1 pr-2 text-right text-fog-50 tabular-nums">
                  {signed(s.deltas.pickup_wait_s, "s")}
                </td>
                <td className="py-1 pr-2 text-right text-fog-200 tabular-nums">
                  {signed(s.deltas.empty_km, "km")}
                </td>
                <td className="py-1 pr-2 text-right text-fog-200 tabular-nums">
                  {signed(s.deltas.pallets_delivered, "pallets")}
                </td>
                <td className="py-1 pr-2 text-right text-fog-400 tabular-nums">
                  {signed(s.deltas.pallets_planned, "pallets")}
                </td>
                <td className={`py-1 ${s.passed ? "text-ok-400" : "text-critical-400"}`}>
                  {s.passed
                    ? "✓ all hold"
                    : `✕ ${s.constraints
                        .filter((c) => !c.satisfied)
                        .map((c) => c.detail)
                        .join("; ")}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
