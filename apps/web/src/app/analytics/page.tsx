"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { API_URL } from "@/lib/api/health";

type Overview = {
  snapshot_id: string;
  as_of: string;
  source_as_of: string | null;
  freshness: "fresh" | "stale" | "no_recent_input";
  reconciliation_status: string;
  metrics: {
    recorded_simulations: number;
    domain_events: number;
    orders_shipped: number;
    orders_cancelled: number;
    mean_order_lead_time_ms: number | null;
    tasks_completed: number;
    mean_task_wait_ms: number | null;
    mean_task_service_ms: number | null;
    inventory_movement_rows: number;
    pallet_flow_events: number;
    data_quality_errors_global: number;
  };
  sample_counts: {
    order_lead_time: number;
    task_wait_time: number;
    task_service_time: number;
  };
};

type DailyVolume = { event_date: string; events: number; redelivered_copies: number };
type Order = {
  simulation_id: string;
  order_id: string;
  status: string;
  ordered_pallets?: number | null;
  lead_time_ms?: number | null;
};
type Task = {
  simulation_id: string;
  task_id: string;
  status: string;
  wait_ms?: number | null;
  service_ms?: number | null;
};
type ListPayload<T> = { rows: T[]; page: { total: number } };
type Health = {
  status: "healthy" | "degraded";
  components: Record<string, { status: string; last_beat_at: string | null; age_seconds: number | null }>;
  latest_reconciliation: { status: string; started_at: string; finished_at: string } | null;
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(body?.error?.message ?? `API request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function number(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function time(value: string | null | undefined): string {
  if (!value) return "No recorded input";
  return new Date(value).toLocaleString();
}

function freshnessLabel(value: Overview["freshness"]): string {
  if (value === "fresh") return "Fresh snapshot";
  if (value === "stale") return "Stale snapshot";
  return "No recent input";
}

function Card({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <article className="panel min-w-0 p-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-fog-400">{label}</p>
      <p className="metric mt-2 text-2xl font-semibold tracking-tight text-fog-50">{value}</p>
      {detail && <p className="mt-1 text-xs text-fog-400">{detail}</p>}
    </article>
  );
}

function StatusDot({ healthy }: { healthy: boolean }) {
  return (
    <span
      aria-label={healthy ? "healthy" : "degraded"}
      className={`inline-block size-2 rounded-full ${healthy ? "bg-ok-400" : "bg-warn-400"}`}
    />
  );
}

export default function AnalyticsPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [volume, setVolume] = useState<DailyVolume[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [simulationInput, setSimulationInput] = useState("");
  const [simulationId, setSimulationId] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      const query = simulationId ? `?simulation_id=${encodeURIComponent(simulationId)}` : "";
      const requests = await Promise.allSettled([
        getJson<Overview>(`/api/v1/analytics/overview${query}`),
        getJson<{ daily: DailyVolume[] }>("/api/v1/analytics/throughput?limit=14"),
        getJson<ListPayload<Order>>(`/api/v1/analytics/orders${query}`),
        getJson<ListPayload<Task>>(`/api/v1/analytics/tasks${query}`),
        getJson<Health>("/api/v1/analytics/health"),
      ]);
      if (!active) return;
      const [o, v, orderRows, taskRows, h] = requests;
      setOverviewError(o.status === "rejected" ? String(o.reason) : null);
      setDetailsError(
        [v, orderRows, taskRows].some((r) => r.status === "rejected")
          ? "Some detail panels could not be loaded."
          : null,
      );
      if (o.status === "fulfilled") setOverview(o.value);
      if (v.status === "fulfilled") setVolume(v.value.daily);
      if (orderRows.status === "fulfilled") setOrders(orderRows.value.rows.slice(0, 8));
      if (taskRows.status === "fulfilled") setTasks(taskRows.value.rows.slice(0, 8));
      if (h.status === "fulfilled") setHealth(h.value);
      setLastChecked(new Date().toISOString());
      setLoading(false);
    };
    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [simulationId]);

  function applyFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSimulationId(simulationInput.trim());
  }

  const maxEvents = Math.max(1, ...volume.map((item) => item.events));

  return (
    <main className="min-h-dvh bg-ink-950 px-4 py-5 text-fog-50 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link href="/" className="text-xs text-data-300 hover:text-fog-50">
              ← Back to 3D warehouse
            </Link>
            <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-signal-300">
              WAREHOUSE ONE / ANALYTICS
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
              Operations intelligence
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-fog-400">
              Historical performance from reconciled dbt gold snapshots. Live KPIs remain in the
              3D operations view.
            </p>
          </div>
          <div className="panel min-w-56 p-3">
            <div className="flex items-center gap-2 text-sm">
              <StatusDot healthy={health?.status === "healthy"} />
              <span>{health?.status === "healthy" ? "Pipeline healthy" : "Pipeline degraded"}</span>
            </div>
            <p className="mt-2 text-xs text-fog-400">
              Last checked: {lastChecked ? time(lastChecked) : "Checking…"}
            </p>
          </div>
        </header>

        <section className="mt-6 panel flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-fog-200">Analytics snapshot</p>
            <p className="mt-1 break-all font-mono text-[11px] text-fog-500">
              {overview?.snapshot_id ?? "Waiting for first successful publication"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded-full border px-3 py-1 text-xs ${
                overview?.freshness === "fresh"
                  ? "border-ok-400/30 bg-ok-400/10 text-ok-400"
                  : "border-warn-400/30 bg-warn-400/10 text-warn-400"
              }`}
            >
              {overview ? freshnessLabel(overview.freshness) : loading ? "Loading" : "Unavailable"}
            </span>
            <p className="text-xs text-fog-400">Published: {time(overview?.as_of)}</p>
          </div>
        </section>

        <form onSubmit={applyFilter} className="mt-5 flex flex-wrap items-end gap-2">
          <label className="flex min-w-64 flex-1 flex-col gap-1.5 text-xs text-fog-400">
            Filter by simulation ID
            <input
              value={simulationInput}
              onChange={(event) => setSimulationInput(event.target.value)}
              placeholder="All recorded simulations"
              className="rounded-lg border border-white/10 bg-ink-900 px-3 py-2.5 text-sm text-fog-50 outline-none focus:border-signal-400"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg bg-signal-400 px-4 py-2.5 text-sm font-semibold text-ink-950 hover:bg-signal-300"
          >
            Apply filter
          </button>
          <button
            type="button"
            onClick={() => {
              setSimulationInput("");
              setSimulationId("");
            }}
            className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-fog-200 hover:bg-white/5"
          >
            Clear
          </button>
        </form>

        {overviewError && (
          <div role="alert" className="mt-5 rounded-xl border border-warn-400/30 bg-warn-400/5 p-4">
            <p className="font-medium text-warn-400">Analytics unavailable</p>
            <p className="mt-1 text-sm text-fog-300">{overviewError}</p>
            <p className="mt-2 text-xs text-fog-400">
              Start the Phase 3 data stack, record a simulation, then wait for a successful refresh
              and reconciliation before a snapshot can be published.
            </p>
          </div>
        )}

        {detailsError && <p className="mt-3 text-xs text-warn-400">{detailsError}</p>}

        <section aria-label="Key metrics" className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="Recorded simulations" value={number(overview?.metrics.recorded_simulations)} />
          <Card label="Domain events" value={number(overview?.metrics.domain_events)} detail="Deduplicated events" />
          <Card
            label="Orders shipped"
            value={number(overview?.metrics.orders_shipped)}
            detail={`${number(overview?.metrics.orders_cancelled)} cancelled`}
          />
          <Card
            label="Mean order lead time"
            value={duration(overview?.metrics.mean_order_lead_time_ms)}
            detail={`${number(overview?.sample_counts.order_lead_time)} shipped orders sampled`}
          />
          <Card
            label="Tasks completed"
            value={number(overview?.metrics.tasks_completed)}
          />
          <Card
            label="Mean task wait"
            value={duration(overview?.metrics.mean_task_wait_ms)}
            detail={`${number(overview?.sample_counts.task_wait_time)} tasks sampled`}
          />
          <Card
            label="Inventory movement rows"
            value={number(overview?.metrics.inventory_movement_rows)}
            detail="Transfer in/out are separate movement sides"
          />
          <Card
            label="Data-quality errors"
            value={number(overview?.metrics.data_quality_errors_global)}
            detail="Global snapshot scope"
          />
        </section>

        <section className="mt-5 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <article className="panel min-w-0 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">Event volume</h2>
                <p className="mt-1 text-xs text-fog-400">
                  Distinct domain events by simulated business date
                </p>
              </div>
              <span className="rounded-md bg-ink-800 px-2 py-1 text-[10px] uppercase tracking-wide text-fog-400">
                Historical
              </span>
            </div>
            {volume.length === 0 ? (
              <p className="py-12 text-center text-sm text-fog-500">No recorded event volume yet.</p>
            ) : (
              <div className="mt-5 space-y-3">
                {volume.map((item) => (
                  <div key={item.event_date} className="grid grid-cols-[86px_1fr_64px] items-center gap-3">
                    <span className="font-mono text-[11px] text-fog-400">{item.event_date}</span>
                    <div className="h-2 overflow-hidden rounded-full bg-ink-800">
                      <div
                        className="h-full rounded-full bg-data-400"
                        style={{ width: `${Math.max(2, (item.events / maxEvents) * 100)}%` }}
                      />
                    </div>
                    <span className="metric text-right text-xs">{number(item.events)}</span>
                  </div>
                ))}
              </div>
            )}
          </article>

          <article className="panel p-4 sm:p-5">
            <h2 className="font-semibold">Pipeline health</h2>
            <p className="mt-1 text-xs text-fog-400">Service heartbeat and reconciliation status</p>
            <div className="mt-4 space-y-3">
              {Object.entries(health?.components ?? {}).map(([name, component]) => (
                <div key={name} className="flex items-center justify-between gap-3 border-b border-white/5 pb-3">
                  <div className="flex items-center gap-2">
                    <StatusDot healthy={component.status === "healthy"} />
                    <span className="text-sm">{name}</span>
                  </div>
                  <span className="text-xs text-fog-400">
                    {component.age_seconds == null ? "No heartbeat" : `${number(component.age_seconds)}s ago`}
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-sm">Latest reconciliation</span>
                <span className="text-xs text-fog-300">
                  {health?.latest_reconciliation?.status ?? "Not run"}
                </span>
              </div>
              <p className="text-xs text-fog-500">
                Source data as of: {time(overview?.source_as_of)}
              </p>
            </div>
          </article>
        </section>

        <section className="mt-5 grid gap-4 xl:grid-cols-2">
          <article className="panel min-w-0 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">Recent orders</h2>
              <span className="text-xs text-fog-500">{orders.length} shown</span>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead className="text-fog-500">
                  <tr>
                    <th className="pb-2 font-medium">Order</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 text-right font-medium">Pallets</th>
                    <th className="pb-2 text-right font-medium">Lead time</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.order_id} className="border-t border-white/5">
                      <td className="py-2.5 font-mono">{order.order_id}</td>
                      <td className="py-2.5 capitalize text-fog-300">{order.status.replaceAll("_", " ")}</td>
                      <td className="py-2.5 text-right">{number(order.ordered_pallets)}</td>
                      <td className="py-2.5 text-right">{duration(order.lead_time_ms)}</td>
                    </tr>
                  ))}
                  {orders.length === 0 && (
                    <tr><td colSpan={4} className="py-8 text-center text-fog-500">No order rows in this snapshot.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <article className="panel min-w-0 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">Recent tasks</h2>
              <span className="text-xs text-fog-500">{tasks.length} shown</span>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[440px] text-left text-xs">
                <thead className="text-fog-500">
                  <tr>
                    <th className="pb-2 font-medium">Task</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 text-right font-medium">Wait</th>
                    <th className="pb-2 text-right font-medium">Service</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.task_id} className="border-t border-white/5">
                      <td className="py-2.5 font-mono">{task.task_id}</td>
                      <td className="py-2.5 capitalize text-fog-300">{task.status.replaceAll("_", " ")}</td>
                      <td className="py-2.5 text-right">{duration(task.wait_ms)}</td>
                      <td className="py-2.5 text-right">{duration(task.service_ms)}</td>
                    </tr>
                  ))}
                  {tasks.length === 0 && (
                    <tr><td colSpan={4} className="py-8 text-center text-fog-500">No task rows in this snapshot.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </section>

        <footer className="mt-6 flex flex-wrap justify-between gap-2 border-t border-white/5 pt-4 text-[11px] text-fog-500">
          <span>WAREHOUSE ONE · Analytics preview</span>
          <span>Auto-refresh every 30 seconds · API {API_URL}</span>
        </footer>
      </div>
    </main>
  );
}
