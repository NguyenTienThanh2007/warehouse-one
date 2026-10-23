"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AnalyticsError,
  analyticsApi,
  type AnalyticsFailure,
  type AnalyticsStatus,
  type RunAnalytics,
  type RunList,
} from "@/lib/analytics/api";
import {
  banners,
  clock,
  compact,
  formatAge,
  formatDuration,
  presetWindow,
  runLabel,
  stamp,
  topWithOther,
  type Banner,
  type WindowPreset,
} from "@/lib/analytics/view";
import { API_URL } from "@/lib/api/health";
import { useSimulation } from "@/lib/sim/store";
import { BarList, TimeChart } from "./charts";

type Load<T> =
  { kind: "loading" } | { kind: "ready"; data: T } | { kind: "failed"; failure: AnalyticsFailure };

const STATUS_POLL_MS = 30_000;

function failureOf(e: unknown): AnalyticsFailure {
  return e instanceof AnalyticsError
    ? e.failure
    : { kind: "contract", message: e instanceof Error ? e.message : String(e) };
}

/**
 * Load something for `key` (null: nothing to load yet). While a different key loads the result is
 * `loading`; a reload of the same key (refresh, polling) keeps showing the previous result.
 */
function useLoad<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>) {
  const [result, setResult] = useState<{ key: string; load: Load<T> } | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (key === null) return;
    const ctl = new AbortController();
    fetcher(ctl.signal).then(
      (data) => setResult({ key, load: { kind: "ready", data } }),
      (e: unknown) => {
        if (!ctl.signal.aborted)
          setResult({ key, load: { kind: "failed", failure: failureOf(e) } });
      },
    );
    return () => ctl.abort();
    // The fetcher is recreated every render; `key` and `nonce` decide when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const load: Load<T> = result && result.key === key ? result.load : { kind: "loading" };
  return [load, useCallback(() => setNonce((n) => n + 1), [])] as const;
}

/**
 * Analytics mode (Phase 4): figures from the latest published snapshot of the reconciled data
 * pipeline — recorded runs, in simulated business time. Never the live simulation.
 */
export function AnalyticsDashboard() {
  const [status, reloadStatus] = useLoad<AnalyticsStatus>("status", (s) => analyticsApi.status(s));
  useEffect(() => {
    const t = setInterval(reloadStatus, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [reloadStatus]);
  const snapshotId = status.kind === "ready" ? (status.data.snapshot?.snapshot_id ?? null) : null;
  const [runs] = useLoad<RunList>(snapshotId, (s) => analyticsApi.runs(snapshotId ?? "", s));

  return (
    <section
      className="pointer-events-auto mx-auto flex w-full max-w-6xl flex-col gap-3 pb-6"
      aria-labelledby="analytics-title"
      data-testid="analytics-dashboard"
      data-state={status.kind === "ready" ? status.data.state : status.kind}
    >
      <header className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 id="analytics-title" className="text-base font-semibold text-fog-50">
            Operations analytics
          </h2>
          <p className="mt-0.5 text-[11px] text-fog-400">
            Published snapshot of recorded runs, processed and reconciled by the data pipeline.
            Times are simulated business time unless marked wall clock. The live simulation is not
            shown here: record a run and it appears after the next pipeline refresh.
          </p>
        </div>
        <span
          className="rounded-full border border-data-400/30 bg-data-400/10 px-2.5 py-1 text-[11px] font-medium text-data-300"
          data-testid="analytics-source-badge"
        >
          Published · historical
        </span>
      </header>
      {status.kind === "loading" && <Skeleton />}
      {status.kind === "failed" && <FailurePanel failure={status.failure} retry={reloadStatus} />}
      {status.kind === "ready" && (
        <>
          <SourceStrip status={status.data} refresh={reloadStatus} />
          {banners(status.data).map((b) => (
            <BannerView key={b.title} banner={b} />
          ))}
          {status.data.state === "empty" ? (
            <EmptyPanel />
          ) : runs.kind === "loading" ? (
            <Skeleton />
          ) : runs.kind === "failed" ? (
            <FailurePanel failure={runs.failure} retry={reloadStatus} />
          ) : runs.data.runs.length === 0 ? (
            <Notice testid="analytics-no-runs" title="The snapshot contains no runs">
              The pipeline published a snapshot, but no recorded run was in the lake when it was
              built.
            </Notice>
          ) : (
            <RunView runs={runs.data} />
          )}
        </>
      )}
    </section>
  );
}

// --- States -------------------------------------------------------------------------------------

function Skeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3" data-testid="analytics-loading" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="panel h-24 animate-pulse bg-ink-850" />
      ))}
      <div className="panel h-52 animate-pulse bg-ink-850 sm:col-span-3" />
    </div>
  );
}

function Notice({
  title,
  children,
  testid,
  action,
}: {
  title: string;
  children: React.ReactNode;
  testid: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="panel p-5" data-testid={testid} role="status">
      <p className="text-sm font-semibold text-fog-50">{title}</p>
      <div className="mt-1 text-xs leading-5 text-fog-400">{children}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

const retryButton = (retry: () => void) => (
  <button
    type="button"
    onClick={retry}
    className="rounded-md bg-signal-400 px-2.5 py-1 text-[11px] font-semibold text-ink-950 hover:bg-signal-300"
    data-testid="analytics-retry"
  >
    Retry
  </button>
);

function FailurePanel({ failure, retry }: { failure: AnalyticsFailure; retry: () => void }) {
  if (failure.kind === "offline")
    return (
      <Notice
        testid="analytics-offline"
        title="Analytics API unavailable"
        action={retryButton(retry)}
      >
        {failure.message} Start it with <code className="text-fog-200">docker compose up -d</code>{" "}
        (and the data platform with <code className="text-fog-200">--profile data</code>). The
        simulation keeps running; nothing is shown here until published data can be read.
      </Notice>
    );
  return (
    <Notice
      testid="analytics-error"
      title="Analytics could not be loaded"
      action={retryButton(retry)}
    >
      <span className="metric text-critical-400">
        {failure.kind === "http" ? `${failure.status} ${failure.code}` : "CONTRACT"}
      </span>{" "}
      {failure.message}
    </Notice>
  );
}

function EmptyPanel() {
  return (
    <Notice testid="analytics-empty" title="Nothing has been published yet">
      Analytics are built from recorded runs. Record one (<em>Record run</em> in Explore, or{" "}
      <code className="text-fog-200">pnpm sim:record</code>), then let the data platform refresh
      (Airflow <code className="text-fog-200">warehouse_lake_refresh</code>): it builds the models,
      reconciles them with the event log and publishes a snapshot only when that passes.
    </Notice>
  );
}

const TONE: Record<Banner["tone"], { box: string; icon: string; label: string }> = {
  critical: { box: "border-critical-400/40 bg-critical-400/10", icon: "✕", label: "Critical" },
  warning: { box: "border-warn-400/40 bg-warn-400/10", icon: "!", label: "Warning" },
  info: { box: "border-data-400/30 bg-data-400/10", icon: "i", label: "Note" },
  ok: { box: "border-ok-400/30 bg-ok-400/10", icon: "✓", label: "OK" },
};

function BannerView({ banner }: { banner: Banner }) {
  const t = TONE[banner.tone];
  return (
    <div
      className={`panel flex gap-3 border px-4 py-3 ${t.box}`}
      role={banner.tone === "critical" ? "alert" : "status"}
      data-testid={`analytics-banner-${banner.tone}`}
    >
      <span
        className="grid size-5 shrink-0 place-items-center rounded-full bg-white/10 text-[11px] font-bold text-fog-50"
        aria-label={t.label}
      >
        {t.icon}
      </span>
      <div className="min-w-0 text-xs">
        <p className="font-semibold text-fog-50">{banner.title}</p>
        {banner.lines.map((l) => (
          <p key={l} className="mt-0.5 text-fog-200">
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

/** Provenance: when it was published (wall clock), what it covers, and the pipeline's health. */
function SourceStrip({ status, refresh }: { status: AnalyticsStatus; refresh: () => void }) {
  const s = status.snapshot;
  const f = status.freshness;
  const rec = status.pipeline.reconciliation;
  const stateLabel = { empty: "Empty", fresh: "Fresh", stale: "Stale", degraded: "Degraded" }[
    status.state
  ];
  const stateTone = {
    empty: "text-fog-200",
    fresh: "text-ok-400",
    stale: "text-warn-400",
    degraded: "text-critical-400",
  }[status.state];
  return (
    <dl
      className="panel grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-[11px] sm:grid-cols-5"
      data-testid="analytics-source"
    >
      <div>
        <dt className="text-fog-400">Snapshot state</dt>
        <dd className={`mt-0.5 font-semibold ${stateTone}`} data-testid="analytics-state">
          {stateLabel}
        </dd>
      </div>
      <div>
        <dt className="text-fog-400">Published (wall clock)</dt>
        <dd className="mt-0.5 text-fog-50" data-testid="analytics-published">
          {s && f ? `${formatAge(f.age_seconds)} · ${stamp(s.generated_at)}` : "—"}
        </dd>
      </div>
      <div>
        <dt className="text-fog-400">Business time covered (simulated)</dt>
        <dd className="mt-0.5 text-fog-50">
          {s?.business_from && s.business_to
            ? `${stamp(s.business_from)} – ${clock(s.business_to)}`
            : "—"}
        </dd>
      </div>
      <div>
        <dt className="text-fog-400">Reconciliation</dt>
        <dd className="mt-0.5 text-fog-50" data-testid="analytics-reconciliation">
          {rec ? `${rec.status} · ${stamp(rec.finished_at)}` : "never run"}
        </dd>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <dt className="text-fog-400">Pipeline</dt>
          <dd
            className={`mt-0.5 ${status.pipeline.healthy ? "text-ok-400" : "text-critical-400"}`}
            data-testid="analytics-pipeline"
          >
            {status.pipeline.healthy
              ? "✓ healthy"
              : `✕ ${status.pipeline.problems.length} problem(s)`}
            {status.pipeline.outbox_unpublished > 0 && (
              <span className="text-fog-400"> · {status.pipeline.outbox_unpublished} queued</span>
            )}
          </dd>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-md px-2 py-1 text-fog-400 hover:bg-white/5 hover:text-fog-200"
          data-testid="analytics-refresh"
        >
          Refresh
        </button>
      </div>
    </dl>
  );
}

// --- One run ------------------------------------------------------------------------------------

const PRESETS: { id: WindowPreset; label: string }[] = [
  { id: "run", label: "Whole run" },
  { id: "first-hour", label: "First hour" },
  { id: "last-hour", label: "Last hour" },
  { id: "custom", label: "Custom" },
];

function RunView({ runs }: { runs: RunList }) {
  const recording = useSimulation((s) => s.recording);
  const [runId, setRunId] = useState(runs.runs[0]?.simulation_id ?? "");
  const run = runs.runs.find((r) => r.simulation_id === runId) ?? runs.runs[0];
  const spanMin = run ? Math.max(1, Math.ceil(run.simulated_span_ms / 60_000)) : 1;
  const [preset, setPreset] = useState<WindowPreset>("run");
  const [custom, setCustom] = useState({ fromMin: 0, toMin: spanMin });
  const win = useMemo(() => (run ? presetWindow(preset, run, custom) : {}), [run, preset, custom]);
  const key = run
    ? `${runs.snapshot_id}/${run.simulation_id}/${win.from ?? ""}/${win.to ?? ""}`
    : null;
  const [analytics, reload] = useLoad<RunAnalytics>(key, (s) =>
    analyticsApi.run(runs.snapshot_id, run?.simulation_id ?? "", win, s),
  );
  if (!run) return null;
  const recordedHere =
    recording?.simulationId && runs.runs.some((r) => r.simulation_id === recording.simulationId);

  return (
    <>
      <div
        className="panel flex flex-wrap items-end gap-3 px-4 py-3 text-[11px]"
        data-testid="analytics-filters"
      >
        <label className="min-w-0 basis-full text-fog-400 sm:basis-auto sm:flex-1">
          Run
          <select
            className="mt-1 w-full rounded-md bg-ink-800 px-2 py-1.5 text-xs text-fog-50"
            value={run.simulation_id}
            onChange={(e) => {
              const next = runs.runs.find((r) => r.simulation_id === e.target.value);
              setRunId(e.target.value);
              setPreset("run");
              setCustom({
                fromMin: 0,
                toMin: Math.max(1, Math.ceil((next?.simulated_span_ms ?? 0) / 60_000)),
              });
            }}
            data-testid="analytics-run"
          >
            {runs.runs.map((r) => (
              <option key={r.simulation_id} value={r.simulation_id}>
                {runLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <div className="text-fog-400">
          Window (simulated)
          <div className="mt-1 flex gap-1" role="radiogroup" aria-label="Time window">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={preset === p.id}
                onClick={() => setPreset(p.id)}
                data-testid={`analytics-window-${p.id}`}
                className={`rounded-md px-2 py-1 text-xs ${preset === p.id ? "bg-ink-700 text-fog-50" : "text-fog-400 hover:bg-white/5"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {preset === "custom" && (
          <div className="flex gap-2 text-fog-400">
            {(["fromMin", "toMin"] as const).map((k) => (
              <label key={k}>
                {k === "fromMin" ? "From minute" : "To minute"}
                <input
                  type="number"
                  min={0}
                  max={spanMin}
                  value={custom[k]}
                  onChange={(e) =>
                    setCustom({ ...custom, [k]: Math.max(0, Math.round(Number(e.target.value))) })
                  }
                  className="mt-1 block w-20 rounded-md bg-ink-800 px-2 py-1.5 text-xs text-fog-50"
                  data-testid={`analytics-custom-${k}`}
                />
              </label>
            ))}
          </div>
        )}
      </div>
      {recordedHere && (
        <p className="px-1 text-[11px] text-fog-400" data-testid="analytics-recorded-here">
          The run being recorded from this browser is in this snapshot up to its last refresh.
        </p>
      )}
      {analytics.kind === "loading" && <Skeleton />}
      {analytics.kind === "failed" && <FailurePanel failure={analytics.failure} retry={reload} />}
      {analytics.kind === "ready" && <RunFigures a={analytics.data} />}
    </>
  );
}

function Tile({
  label,
  value,
  note,
  testid,
}: {
  label: string;
  value: string;
  note?: string;
  testid: string;
}) {
  return (
    <div className="panel px-4 py-3" data-testid={testid}>
      <p className="text-[11px] text-fog-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-fog-50" data-testid={`${testid}-value`}>
        {value}
      </p>
      {note && <p className="mt-0.5 text-[11px] text-fog-400">{note}</p>}
    </div>
  );
}

function RunFigures({ a }: { a: RunAnalytics }) {
  const k = a.kpis;
  const labels = a.series.map((p) => clock(p.bucket_start));
  const flows = a.pallet_flows.map((f) => ({
    key: `${f.flow}:${f.detail}`,
    label: `${f.flow} · ${f.detail.replace(">", " → ")}`,
    value: f.pallets,
  }));
  const bad = a.quality.filter((q) => q.kind === "error" && q.value > 0);
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="analytics-run-figures"
      data-simulation-id={a.simulation_id}
    >
      <p className="px-1 text-[11px] text-fog-400" data-testid="analytics-window">
        Window {stamp(a.window.business_from)} – {clock(a.window.business_to)} (simulated) ·{" "}
        {a.window.buckets} buckets of {formatDuration(a.window.resolution_ms)}
        {a.window.clamped ? " · cut to the run's extent" : ""}
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Tile
          testid="kpi-events"
          label="Events"
          value={compact(k.events)}
          note="distinct, deduplicated"
        />
        <Tile
          testid="kpi-tasks"
          label="Tasks completed"
          value={compact(k.tasks_completed)}
          note={`median cycle ${formatDuration(k.task_cycle_p50_ms)}`}
        />
        <Tile
          testid="kpi-orders"
          label="Orders shipped"
          value={compact(k.orders_shipped)}
          note={`median lead ${formatDuration(k.order_lead_p50_ms)} · ${k.orders_open_at_end} open at end`}
        />
        <Tile
          testid="kpi-received"
          label="Pallets received"
          value={compact(k.pallets_received)}
          note="receipts and inbound trucks"
        />
        <Tile
          testid="kpi-shipped"
          label="Pallets shipped"
          value={compact(k.pallets_shipped)}
          note={
            k.pallets_shipped_per_hour === null
              ? undefined
              : `${k.pallets_shipped_per_hour.toLocaleString("en-US")} per simulated hour`
          }
        />
        <Tile
          testid="kpi-transfers"
          label="Transfers delivered"
          value={compact(k.transfers_delivered)}
          note={`${k.transfer_pallets_delivered} pallets · median ${formatDuration(k.transfer_lead_p50_ms)}`}
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <TimeChart
          testid="chart-activity"
          title="Event activity"
          subtitle={`Distinct events per ${formatDuration(a.window.resolution_ms)} of simulated time`}
          labels={labels}
          series={[{ name: "Events", values: a.series.map((p) => p.events) }]}
          kind="columns"
          unit="events"
        />
        <TimeChart
          testid="chart-tasks"
          title="Task flow"
          subtitle="Tasks created and completed per bucket"
          labels={labels}
          series={[
            { name: "Created", values: a.series.map((p) => p.tasks_created) },
            { name: "Completed", values: a.series.map((p) => p.tasks_completed) },
          ]}
          kind="lines"
          unit="tasks"
        />
        <TimeChart
          testid="chart-pallets"
          title="Pallet flow"
          subtitle="Pallets created (received) and removed (shipped or adjusted) per bucket"
          labels={labels}
          series={[
            { name: "Created", values: a.series.map((p) => p.pallets_created) },
            { name: "Removed", values: a.series.map((p) => p.pallets_removed) },
          ]}
          kind="lines"
          unit="pallets"
        />
        <BarList
          testid="chart-event-types"
          title="Events by type"
          subtitle="Largest seven, the rest folded into Other"
          rows={topWithOther(a.events_by_type, 8)}
          unit="events"
        />
        <BarList
          testid="chart-task-cycle"
          title="Task cycle time by type"
          subtitle="Median, created → completed, tasks completed in the window"
          rows={a.tasks_by_type
            .filter((t) => t.cycle_p50_ms !== null)
            .map((t) => ({
              key: t.task_type,
              value: t.cycle_p50_ms ?? 0,
              note: `· ${t.completed} done · p90 ${formatDuration(t.cycle_p90_ms)}`,
            }))}
          unit="simulated ms"
          format={formatDuration}
        />
        <BarList
          testid="chart-pallet-flows"
          title="Pallet flows"
          subtitle="By cause, route or reason"
          rows={flows}
          unit="pallets"
        />
      </div>
      {a.transfers_by_lane.length > 0 && (
        <figure className="panel p-4" data-testid="analytics-lanes">
          <figcaption className="text-sm font-semibold text-fog-50">
            Inter-site transfers by lane
          </figcaption>
          <table className="mt-2 w-full text-left text-[11px] tabular-nums">
            <thead className="text-fog-400">
              <tr>
                <th className="py-1 font-medium">Lane</th>
                <th className="py-1 font-medium">Route</th>
                <th className="py-1 text-right font-medium">Delivered</th>
                <th className="py-1 text-right font-medium">Pallets</th>
                <th className="py-1 text-right font-medium">Median lead</th>
              </tr>
            </thead>
            <tbody className="text-fog-200">
              {a.transfers_by_lane.map((l) => (
                <tr
                  key={`${l.lane_id}${l.from_site_id}${l.to_site_id}`}
                  className="border-t border-white/5"
                  data-testid="analytics-lane"
                >
                  <td className="py-1">{l.lane_id}</td>
                  <td className="py-1">
                    {l.from_site_id} → {l.to_site_id}
                  </td>
                  <td className="py-1 text-right">{l.delivered}</td>
                  <td className="py-1 text-right">{l.pallets}</td>
                  <td className="py-1 text-right">{formatDuration(l.lead_p50_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <dl
          className="panel grid grid-cols-2 gap-2 p-4 text-[11px]"
          data-testid="analytics-integrity"
        >
          <dt className="col-span-2 text-sm font-semibold text-fog-50">
            Run integrity (whole run)
          </dt>
          <dt className="text-fog-400">Events in the run</dt>
          <dd className="text-right text-fog-50 tabular-nums">
            {a.integrity.events.toLocaleString("en-US")}
          </dd>
          <dt className="text-fog-400">Missing sequence numbers</dt>
          <dd
            className={`text-right tabular-nums ${a.integrity.missing_sequences ? "text-critical-400" : "text-fog-50"}`}
          >
            {a.integrity.missing_sequences}
          </dd>
          <dt className="text-fog-400">Redelivered copies (not counted twice)</dt>
          <dd className="text-right text-fog-50 tabular-nums" data-testid="analytics-redelivered">
            {a.integrity.redelivered_copies}
          </dd>
        </dl>
        <div className="panel p-4 text-[11px]" data-testid="analytics-quality">
          <p className="text-sm font-semibold text-fog-50">Data quality (whole lake)</p>
          <p className={`mt-1 ${bad.length ? "text-critical-400" : "text-ok-400"}`}>
            {bad.length ? `✕ ${bad.length} check(s) failing` : "✓ every error check is clean"}
          </p>
          <ul className="mt-2 space-y-0.5">
            {a.quality.map((q) => (
              <li key={q.check_name} className="flex justify-between gap-2 text-fog-200">
                <span>
                  {q.check_name.replaceAll("_", " ")}
                  {q.kind === "error" && <span className="ml-1 text-fog-500">(error check)</span>}
                </span>
                <span className="tabular-nums">{q.value.toLocaleString("en-US")}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="px-1 text-[10px] text-fog-500" data-testid="analytics-lineage">
        Snapshot {a.snapshot_id} · generated {stamp(a.generated_at)} (wall clock) · source {API_URL}
      </p>
    </div>
  );
}
