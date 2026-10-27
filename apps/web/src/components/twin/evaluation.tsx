"use client";

import { standbySites, type NetworkConfig } from "@warehouse-one/simulation";
import { planCounts, type CandidateResult, type Evaluation } from "@warehouse-one/twin";
import { useMemo, useState } from "react";
import { useSimulation } from "@/lib/sim/store";
import { useTwin } from "@/lib/twin/store";
import {
  deltaTone,
  formatDelta,
  formatValue,
  HORIZONS,
  horizonMinutes,
  metricLabel,
  planRows,
  PRIMARY,
  VERDICT_LABEL,
  type Tone,
} from "@/lib/twin/view";
import { Badge, Button, Panel, Provenance } from "./parts";

/** Optimiser controls, progress and the what-if editor. */
export function EvaluationControls() {
  const evaluation = useTwin((s) => s.evaluation);
  const horizon = useTwin((s) => s.horizonTicks);
  const busy = useTwin((s) => s.busy);
  const { setHorizon, optimize, cancel } = useTwin.getState();
  const running = evaluation.kind === "running";
  return (
    <Panel
      title="Optimise fleet standby"
      subtitle="Where should idle line-haul trucks wait between jobs? The optimiser simulates candidate plans forward from a frozen copy of the live state and compares them with the plan in effect."
      testid="twin-optimizer"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[11px] text-fog-400">
          Horizon (simulated)
          <select
            className="mt-1 block rounded-md border border-white/10 bg-ink-850 px-2 py-1.5 text-xs text-fog-50"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            disabled={running}
            data-testid="twin-horizon"
          >
            {HORIZONS.map((h) => (
              <option key={h.ticks} value={h.ticks}>
                {h.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          testid="twin-run"
          onClick={() => void optimize()}
          disabled={running || busy === "save"}
        >
          {running ? "Optimising…" : "Run optimisation"}
        </Button>
        {running && (
          <Button variant="secondary" onClick={cancel} testid="twin-cancel">
            Cancel
          </Button>
        )}
      </div>
      {running && <ProgressBar />}
      <p className="mt-3 text-[11px] leading-4 text-fog-400" data-testid="twin-isolation-note">
        Isolated: every plan is simulated on a frozen snapshot taken when you start, by the same
        engine, apart from the live run. The live simulation keeps running and is never changed by
        an evaluation; only an approved proposal that you apply changes it.
      </p>
      <WhatIfEditor disabled={running} />
    </Panel>
  );
}

function ProgressBar() {
  const evaluation = useTwin((s) => s.evaluation);
  if (evaluation.kind !== "running") return null;
  const p = evaluation.progress;
  const pct = Math.round((p?.fraction ?? 0) * 100);
  return (
    <div className="mt-3" data-testid="twin-progress" aria-live="polite">
      <div className="flex justify-between text-[11px] text-fog-400">
        <span>
          {evaluation.what === "optimize" ? "Optimising" : "Comparing"} from tick{" "}
          {evaluation.tick.toLocaleString("en-US")} · simulation{" "}
          {Math.min((p?.simulations_done ?? 0) + 1, p?.simulations_budget ?? 1)} of{" "}
          {p?.simulations_budget ?? "…"}
        </span>
        <span className="tabular-nums">{pct} %</span>
      </div>
      <div
        className="mt-1 h-1.5 rounded-full bg-ink-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Evaluation progress"
      >
        <div
          className="h-1.5 rounded-full bg-data-400 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      {p?.label && <p className="mt-1 truncate text-[11px] text-fog-200">{p.label}</p>}
    </div>
  );
}

/** The operator's own alternative: trucks per site, compared with the plan in effect. */
function WhatIfEditor({ disabled }: { disabled: boolean }) {
  const config = useSimulation((s) => s.config);
  const net = config.network as NetworkConfig;
  const sites = useMemo(() => standbySites(net), [net]);
  const fleet = net.vehicles.length;
  const [counts, setCounts] = useState<Record<string, number>>({});
  const stalls = (id: string) =>
    sites.find((s) => s.id === id)?.stands.filter((x) => x.kind === "staging").length ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <details
      className="mt-4 rounded-lg border border-white/10 bg-ink-850/60 p-3"
      data-testid="twin-whatif"
    >
      <summary className="cursor-pointer text-xs font-semibold text-fog-50">
        What-if: compare your own standby plan
      </summary>
      <p className="mt-1 text-[11px] text-fog-400">
        Trucks to keep on standby per site ({fleet} in the fleet; the rest wait at the depot). The
        same rules apply as for the optimiser: a plan that breaks one is reported as infeasible, not
        adjusted.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {sites.map((s) => (
          <label key={s.id} className="text-[11px] text-fog-400">
            {s.name}
            <input
              type="number"
              min={0}
              max={stalls(s.id)}
              value={counts[s.id] ?? 0}
              onChange={(e) =>
                setCounts({
                  ...counts,
                  [s.id]: Math.max(
                    0,
                    Math.min(stalls(s.id), Math.floor(Number(e.target.value) || 0)),
                  ),
                })
              }
              className="mt-1 block w-full rounded-md border border-white/10 bg-ink-900 px-2 py-1 text-xs text-fog-50"
              data-testid={`twin-whatif-${s.id}`}
              disabled={disabled}
            />
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="secondary"
          testid="twin-whatif-run"
          disabled={disabled || total > fleet}
          onClick={() => void useTwin.getState().compare(new Map(Object.entries(counts)))}
        >
          Compare with the plan in effect
        </Button>
        {total > fleet && (
          <span className="text-[11px] text-warn-400">Only {fleet} trucks in the fleet.</span>
        )}
      </div>
    </details>
  );
}

// --- Results --------------------------------------------------------------------------------

const VERDICT_TONE: Record<CandidateResult["verdict"], Tone> = {
  recommended: "ok",
  improves: "info",
  no_better: "muted",
  infeasible: "critical",
};

/** Baseline vs candidates: recommendation, objective chart, metric table, constraints. */
export function EvaluationResult({ evaluation }: { evaluation: Evaluation }) {
  const selectedId = useTwin((s) => s.selected);
  const selected =
    evaluation.candidates.find((c) => c.candidate_id === selectedId) ?? evaluation.candidates[0];
  const minutes = horizonMinutes(evaluation.options.horizon_ticks);
  return (
    <div className="flex flex-col gap-3" data-testid="twin-result" data-kind={evaluation.kind}>
      <Recommendation evaluation={evaluation} minutes={minutes} />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <ObjectiveChart evaluation={evaluation} />
        {selected && <Comparison evaluation={evaluation} candidate={selected} />}
      </div>
      <Assumptions evaluation={evaluation} />
    </div>
  );
}

function Recommendation({ evaluation, minutes }: { evaluation: Evaluation; minutes: number }) {
  const rec = evaluation.recommendation;
  const chosen = evaluation.candidates.find((c) => c.candidate_id === rec?.candidate_id);
  return (
    <Panel
      title={rec ? "Recommendation" : "No plan to recommend"}
      subtitle={`${evaluation.kind === "what_if" ? "What-if comparison" : "Optimisation"} from tick ${evaluation.source.tick.toLocaleString("en-US")} (simulated ${evaluation.source.simulated_at.slice(11, 19)}), ${minutes} simulated minutes ahead · ${evaluation.search.simulations} simulations · strategy ${evaluation.strategy.id} v${evaluation.strategy.version}`}
      aside={<Provenance kind="simulated" />}
      testid={rec ? "twin-recommendation" : "twin-no-recommendation"}
    >
      {rec && chosen ? (
        <>
          <p className="text-sm text-fog-50" data-testid="twin-recommendation-summary">
            {rec.summary}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-fog-200">
            {rec.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <PlanView
              title="Plan in effect"
              plan={evaluation.baseline.plan}
              evaluation={evaluation}
            />
            <PlanView title="Proposed plan" plan={chosen.plan} evaluation={evaluation} highlight />
          </div>
          <Constraints candidate={chosen} />
        </>
      ) : (
        <p className="text-xs leading-5 text-fog-200" data-testid="twin-no-recommendation-reason">
          {evaluation.no_recommendation_reason}
        </p>
      )}
    </Panel>
  );
}

function PlanView({
  title,
  plan,
  evaluation,
  highlight,
}: {
  title: string;
  plan: CandidateResult["plan"];
  evaluation: Evaluation;
  highlight?: boolean;
}) {
  const rows = planRows(plan, evaluation.demand);
  return (
    <div
      className={`rounded-lg border p-3 ${highlight ? "border-signal-400/40 bg-signal-400/5" : "border-white/10 bg-ink-850/60"}`}
      data-testid={highlight ? "twin-plan-proposed" : "twin-plan-current"}
    >
      <p className="text-[11px] font-semibold text-fog-200">{title}</p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {rows.map((r) => (
          <li key={r.key} className="flex justify-between gap-2">
            <span className="text-fog-200">{r.label}</span>
            <span className="text-fog-50 tabular-nums">
              {r.trucks} truck{r.trucks === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Constraints({ candidate }: { candidate: CandidateResult }) {
  return (
    <div className="mt-3" data-testid="twin-constraints">
      <p className="text-[11px] font-semibold text-fog-200">Hard constraints</p>
      <ul className="mt-1 grid gap-1 sm:grid-cols-2">
        {candidate.constraints.map((c) => (
          <li
            key={c.id}
            className="flex gap-2 text-[11px]"
            data-testid="twin-constraint"
            data-satisfied={c.satisfied}
          >
            <span className={c.satisfied ? "text-ok-400" : "text-critical-400"} aria-hidden>
              {c.satisfied ? "✓" : "✕"}
            </span>
            <span className="text-fog-200">
              {c.label}
              <span className="text-fog-400"> · {c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Primary objective for the baseline and every candidate; lower is better. */
function ObjectiveChart({ evaluation }: { evaluation: Evaluation }) {
  const selectedId = useTwin((s) => s.selected);
  const rows = [
    {
      id: "baseline",
      label: "Plan in effect (baseline)",
      value: evaluation.baseline.metrics[PRIMARY],
      verdict: null as CandidateResult["verdict"] | null,
    },
    ...evaluation.candidates.map((c) => ({
      id: c.candidate_id,
      label: c.label,
      value: c.metrics?.[PRIMARY] ?? null,
      verdict: c.verdict,
    })),
  ];
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <Panel
      title="Mean pickup wait by plan"
      subtitle="Simulated seconds from a transfer being planned to a truck starting to load it. Lower is better. Select a plan to compare it in detail."
      testid="twin-objective-chart"
    >
      <ul className="space-y-2" aria-label="Mean pickup wait (s) by plan">
        {rows.map((r) => {
          const selectable = r.id !== "baseline";
          const active = r.id === selectedId;
          const bar =
            r.verdict === "recommended"
              ? "bg-ok-400"
              : r.id === "baseline"
                ? "bg-fog-400"
                : "bg-data-400";
          return (
            <li key={r.id}>
              <button
                type="button"
                disabled={!selectable}
                onClick={() => useTwin.getState().select(r.id)}
                aria-pressed={selectable ? active : undefined}
                className={`w-full rounded-md px-2 py-1 text-left text-[11px] ${active ? "bg-white/10" : selectable ? "hover:bg-white/5" : ""}`}
                data-testid="twin-candidate-row"
                data-candidate={r.id}
                data-verdict={r.verdict ?? "baseline"}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-fog-200" title={r.label}>
                    {r.label}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {r.verdict && (
                      <Badge tone={VERDICT_TONE[r.verdict]}>{VERDICT_LABEL[r.verdict]}</Badge>
                    )}
                    <span className="text-fog-50 tabular-nums">
                      {r.value === null
                        ? r.verdict === "infeasible"
                          ? "not simulated"
                          : "—"
                        : `${r.value.toFixed(1)} s`}
                    </span>
                  </span>
                </span>
                <span className="mt-1 block h-2 rounded-full bg-ink-800">
                  <span
                    className={`block h-2 rounded-full ${bar}`}
                    style={{ width: `${((r.value ?? 0) / max) * 100}%` }}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

const TONE_TEXT = { better: "text-ok-400", worse: "text-critical-400", neutral: "text-fog-200" };

function Comparison({
  evaluation,
  candidate,
}: {
  evaluation: Evaluation;
  candidate: CandidateResult;
}) {
  return (
    <Panel
      title={`Baseline vs ${candidate.label}`}
      subtitle={`Both computed by the same rules from the same snapshot over ${horizonMinutes(evaluation.options.horizon_ticks)} simulated minutes. Workload metrics (grey) describe the demand, not the plan.`}
      aside={
        <Badge tone={VERDICT_TONE[candidate.verdict]}>{VERDICT_LABEL[candidate.verdict]}</Badge>
      }
      testid="twin-comparison"
    >
      {candidate.metrics ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-[11px]">
            <thead className="text-fog-400">
              <tr>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Metric
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  Baseline
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  Candidate
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {candidate.deltas.map((d) => (
                <tr
                  key={d.key}
                  className="border-t border-white/5"
                  data-testid="twin-metric-row"
                  data-key={d.key}
                >
                  <th
                    scope="row"
                    className={`py-1 pr-2 font-normal ${d.better === "info" ? "text-fog-400" : "text-fog-200"}`}
                  >
                    {metricLabel(d.key)}
                  </th>
                  <td className="py-1 pr-2 text-right text-fog-50 tabular-nums">
                    {formatValue(d.baseline, d.unit)}
                  </td>
                  <td className="py-1 pr-2 text-right text-fog-50 tabular-nums">
                    {formatValue(d.candidate, d.unit)}
                  </td>
                  <td
                    className={`py-1 text-right tabular-nums ${TONE_TEXT[deltaTone(d)]}`}
                    data-testid="twin-metric-delta"
                  >
                    {formatDelta(d)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-fog-200" data-testid="twin-infeasible">
          Not simulated: the plan breaks a hard rule.
        </p>
      )}
      {candidate.reasons.length > 0 && (
        <ul
          className="mt-2 space-y-0.5 text-[11px] text-fog-400"
          data-testid="twin-candidate-reasons"
        >
          {candidate.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {!candidate.feasible && <Constraints candidate={candidate} />}
    </Panel>
  );
}

function Assumptions({ evaluation }: { evaluation: Evaluation }) {
  const counts = planCounts(evaluation.baseline.plan);
  return (
    <details className="panel p-4 text-xs" data-testid="twin-assumptions">
      <summary className="cursor-pointer font-semibold text-fog-50">
        Assumptions, risks and inputs
      </summary>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold text-fog-200">Assumptions</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] text-fog-400">
            {evaluation.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-[11px] font-semibold text-fog-200">Risks and uncertainty</p>
          <ul
            className="mt-1 list-disc space-y-1 pl-4 text-[11px] text-fog-400"
            data-testid="twin-risks"
          >
            {evaluation.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      </div>
      <dl
        className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4"
        data-testid="twin-inputs"
      >
        <div>
          <dt className="text-fog-400">Source run</dt>
          <dd className="metric truncate text-fog-200" title={evaluation.source.simulation_id}>
            {evaluation.source.simulation_id.slice(0, 8)}
          </dd>
        </div>
        <div>
          <dt className="text-fog-400">State hash</dt>
          <dd className="metric text-fog-200">{evaluation.source.state_hash.slice(0, 12)}</dd>
        </div>
        <div>
          <dt className="text-fog-400">Evaluation id</dt>
          <dd className="metric truncate text-fog-200" title={evaluation.evaluation_id}>
            {evaluation.evaluation_id.slice(0, 8)}
          </dd>
        </div>
        <div>
          <dt className="text-fog-400">Trucks on standby (baseline)</dt>
          <dd className="text-fog-200">
            {evaluation.baseline.plan.assignments.length - (counts.home ?? 0)}
          </dd>
        </div>
      </dl>
    </details>
  );
}
