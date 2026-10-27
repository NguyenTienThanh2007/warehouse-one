/**
 * Client for the analytics read API (Phase 4, `GET /api/v1/analytics/*`). Every response is
 * validated against the schemas below, which mirror apps/api/src/warehouse_api/analytics/schemas.py;
 * a response that does not match is reported as a contract error, never shown as data.
 *
 * Time: `business_*`, window bounds and `bucket_start` are simulated business time; `generated_at`,
 * `server_time` and other `*_at` fields are wall-clock times. Durations ending in `_ms` are
 * simulated milliseconds.
 */
import { z } from "zod";
import { ApiRequestError, requestJson, type ApiFailure, type Feature } from "../api/request";

const ts = z.iso.datetime({ offset: true });
const count = z.int().nonnegative();
const ms = z.int().nullable();

export const SnapshotMeta = z.object({
  snapshot_id: z.uuid(),
  catalogue_version: z.int(),
  generated_at: ts,
  gold_built_at: ts,
  reconciliation_status: z.enum(["passed", "not_required"]),
  reconciliation_report_id: z.uuid().nullable(),
  reconciliation_finished_at: ts.nullable(),
  source_watermark: ts.nullable(),
  source_events: count,
  run_count: count,
  business_from: ts.nullable(),
  business_to: ts.nullable(),
  time_basis: z.literal("simulated"),
});

export const AnalyticsStatus = z.object({
  state: z.enum(["empty", "fresh", "stale", "degraded"]),
  server_time: ts,
  snapshot: SnapshotMeta.nullable(),
  freshness: z
    .object({
      age_seconds: z.number().nonnegative(),
      stale_after_seconds: z.int(),
      is_stale: z.boolean(),
      events_recorded_after: count,
      latest_event_recorded_at: ts.nullable(),
    })
    .nullable(),
  pipeline: z.object({
    healthy: z.boolean(),
    problems: z.array(z.string()),
    reconciliation: z
      .object({
        report_id: z.uuid(),
        status: z.enum(["passed", "failed", "not_settled"]),
        finished_at: ts,
        triggered_by: z.string(),
      })
      .nullable(),
    components: z.array(
      z.object({
        component: z.string(),
        instance: z.string(),
        status: z.string(),
        last_beat_at: ts,
        age_seconds: z.number(),
        healthy: z.boolean(),
      }),
    ),
    outbox_unpublished: count,
    dead_letters: count,
  }),
});
export type AnalyticsStatus = z.infer<typeof AnalyticsStatus>;

export const RunSummary = z.object({
  simulation_id: z.uuid(),
  scenario_id: z.string().nullable(),
  run_epoch: ts,
  business_from: ts,
  business_to: ts,
  simulated_span_ms: count,
  events: count,
  event_types: count,
  missing_sequences: count,
  redelivered_copies: count,
});
export type RunSummary = z.infer<typeof RunSummary>;

export const RunList = z.object({
  snapshot_id: z.uuid(),
  generated_at: ts,
  time_basis: z.literal("simulated"),
  runs: z.array(RunSummary),
});
export type RunList = z.infer<typeof RunList>;

const keyed = z.object({ key: z.string(), value: z.int() });

export const RunAnalytics = z.object({
  snapshot_id: z.uuid(),
  generated_at: ts,
  simulation_id: z.uuid(),
  scenario_id: z.string().nullable(),
  time_basis: z.literal("simulated"),
  run_business_from: ts,
  run_business_to: ts,
  window: z.object({
    business_from: ts,
    business_to: ts,
    from_ms: z.int(),
    to_ms: z.int(),
    resolution_ms: z.int().positive(),
    buckets: count,
    clamped: z.boolean(),
  }),
  kpis: z.object({
    events: count,
    tasks_created: count,
    tasks_completed: count,
    tasks_cancelled: count,
    task_cycle_p50_ms: ms,
    task_cycle_p90_ms: ms,
    task_wait_p50_ms: ms,
    tasks_completed_per_hour: z.number().nullable(),
    orders_opened: count,
    orders_shipped: count,
    orders_cancelled: count,
    orders_open_at_end: count,
    order_lead_p50_ms: ms,
    order_lead_p90_ms: ms,
    pallets_created: count,
    pallets_received: count,
    pallets_moved: count,
    pallets_shipped: count,
    pallets_shipped_per_hour: z.number().nullable(),
    transfers_delivered: count,
    transfer_pallets_delivered: count,
    transfer_lead_p50_ms: ms,
  }),
  series: z.array(
    z.object({
      bucket_start: ts,
      offset_ms: z.int(),
      events: count,
      tasks_created: count,
      tasks_completed: count,
      orders_shipped: count,
      pallets_created: count,
      pallets_removed: count,
    }),
  ),
  events_by_type: z.array(keyed),
  tasks_by_type: z.array(
    z.object({
      task_type: z.string(),
      created: count,
      completed: count,
      cancelled: count,
      cycle_p50_ms: ms,
      cycle_p90_ms: ms,
    }),
  ),
  pallet_flows: z.array(
    z.object({ flow: z.enum(["created", "moved", "removed"]), detail: z.string(), pallets: count }),
  ),
  inventory_units: z.array(keyed),
  transfers_by_lane: z.array(
    z.object({
      lane_id: z.string(),
      from_site_id: z.string().nullable(),
      to_site_id: z.string().nullable(),
      delivered: count,
      pallets: count,
      lead_p50_ms: ms,
    }),
  ),
  integrity: z.object({ events: count, missing_sequences: count, redelivered_copies: count }),
  quality: z.array(z.object({ check_name: z.string(), kind: z.string(), value: z.int() })),
});
export type RunAnalytics = z.infer<typeof RunAnalytics>;

/** Why a request did not produce data (the shared API failure kinds, lib/api/request.ts). */
export type AnalyticsFailure = ApiFailure;
export { ApiRequestError as AnalyticsError };

const ANALYTICS: Feature = { name: "analytics API", since: "Phase 4 analytics" };

const get = <T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) =>
  requestJson(ANALYTICS, path, schema, { signal });

export const analyticsApi = {
  status: (signal?: AbortSignal) => get("/api/v1/analytics/status", AnalyticsStatus, signal),
  runs: (snapshotId: string, signal?: AbortSignal) =>
    get(`/api/v1/analytics/runs?snapshot_id=${snapshotId}`, RunList, signal),
  run: (
    snapshotId: string,
    simulationId: string,
    window: { from?: string; to?: string },
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams({ snapshot_id: snapshotId });
    if (window.from) q.set("from", window.from);
    if (window.to) q.set("to", window.to);
    return get(`/api/v1/analytics/runs/${simulationId}?${q}`, RunAnalytics, signal);
  },
};
