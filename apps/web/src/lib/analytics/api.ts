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
import { API_SERVICE, API_URL } from "../api/health";

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

/** Why a request did not produce data. `url` is the API base the request went to. */
export type AnalyticsFailure =
  /** Nothing answered at the URL (connection refused, DNS, timeout). */
  | { kind: "offline"; url: string; message: string }
  /** The API answered but its CORS policy does not allow this page's origin. */
  | { kind: "blocked"; url: string; origin: string; message: string }
  /** Something answered, but it is not this API, or this API has no analytics routes. */
  | { kind: "mismatch"; url: string; message: string }
  /** The analytics API answered with an error. */
  | { kind: "http"; status: number; code: string; message: string }
  /** The analytics API answered with a body that does not match the schema. */
  | { kind: "contract"; message: string };

export class AnalyticsError extends Error {
  constructor(readonly failure: AnalyticsFailure) {
    super(failure.message);
  }
}

const TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 3000;

/** Our error envelope: `{"error": {"code", "message", "details"}}`. */
function envelope(body: unknown): { code: string; message?: string } | null {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return typeof err?.code === "string"
    ? { code: err.code, message: typeof err.message === "string" ? err.message : undefined }
    : null;
}

/**
 * A request failed before any response. A browser reports a refused connection and a CORS
 * refusal the same way, so ask again in `no-cors` mode: an opaque answer means the server is up
 * and only CORS stood in the way.
 */
async function diagnoseNoResponse(url: string, timedOut: boolean): Promise<AnalyticsFailure> {
  if (timedOut)
    return {
      kind: "offline",
      url: API_URL,
      message: `The analytics API at ${API_URL} did not answer within ${TIMEOUT_MS / 1000} s.`,
    };
  const answered = await fetch(url, {
    mode: "no-cors",
    cache: "no-store",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }).then(
    () => true,
    () => false,
  );
  if (!answered)
    return {
      kind: "offline",
      url: API_URL,
      message: `Nothing answers at ${API_URL}.`,
    };
  const origin = globalThis.location?.origin ?? "this page";
  return {
    kind: "blocked",
    url: API_URL,
    origin,
    message: `The API at ${API_URL} answered, but its CORS policy does not allow requests from ${origin}.`,
  };
}

/** Which server is this? Our API names itself on GET /health. */
async function identify(): Promise<{ ours: true; version: string } | { ours: false }> {
  try {
    const res = await fetch(`${API_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = (await res.json()) as { service?: unknown; version?: unknown };
    return body?.service === API_SERVICE
      ? { ours: true, version: typeof body.version === "string" ? body.version : "?" }
      : { ours: false };
  } catch {
    return { ours: false };
  }
}

const notOurs = (): AnalyticsFailure => ({
  kind: "mismatch",
  url: API_URL,
  message: `The server at ${API_URL} is not the WAREHOUSE ONE API: its GET /health does not identify it. Another application may be using that port; point the web app at the port the API is published on (API_PORT in .env).`,
});

async function get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const url = `${API_URL}${path}`;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new AnalyticsError(await diagnoseNoResponse(url, timeout.aborted));
  }
  let body: unknown = null;
  let json = true;
  try {
    body = await res.json();
  } catch {
    json = false;
  }
  if (!res.ok) {
    const err = envelope(body);
    if (err)
      throw new AnalyticsError({
        kind: "http",
        status: res.status,
        code: err.code,
        message: err.message ?? `The analytics API answered ${res.status}.`,
      });
    // No error envelope: an unknown route (FastAPI's default 404), or not our API at all.
    const who = await identify();
    if (!who.ours) throw new AnalyticsError(notOurs());
    if (res.status === 404 || res.status === 405)
      throw new AnalyticsError({
        kind: "mismatch",
        url: API_URL,
        message: `The WAREHOUSE ONE API at ${API_URL} (v${who.version}) has no route GET ${path.split("?")[0]}: it was built before Phase 4 analytics. Rebuild and recreate it: docker compose up -d --build api.`,
      });
    throw new AnalyticsError({
      kind: "http",
      status: res.status,
      code: json ? `HTTP_${res.status}` : "INVALID_JSON",
      message: `The analytics API answered ${res.status}.`,
    });
  }
  const parsed = json ? schema.safeParse(body) : null;
  if (!parsed?.success) {
    if (!(await identify()).ours) throw new AnalyticsError(notOurs());
    const issue = parsed?.error.issues[0];
    throw new AnalyticsError({
      kind: "contract",
      message: parsed
        ? `Unexpected response from ${path}: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim() +
          ". The API and the web app may be from different versions."
        : `The analytics API answered ${res.status} without valid JSON.`,
    });
  }
  return parsed.data;
}

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
