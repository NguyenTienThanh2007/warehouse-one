import type { z } from "zod";
import { API_SERVICE, API_URL } from "./health";

/**
 * JSON requests to the WAREHOUSE ONE API with an explanation for every way they can fail.
 * The browser cannot see why a request failed (a refused connection and a CORS refusal are the
 * same TypeError), so the client asks follow-up questions: a `no-cors` probe tells a server that
 * is up from one that is not, and GET /health tells this API from another application or from an
 * older build of this API.
 */

/** Why a request did not produce data. `url` is the API base the request went to. */
export type ApiFailure =
  /** Nothing answered at the URL (connection refused, DNS, timeout). */
  | { kind: "offline"; url: string; message: string }
  /** The API answered but its CORS policy does not allow this page's origin. */
  | { kind: "blocked"; url: string; origin: string; message: string }
  /** Something answered, but it is not this API, or this API lacks the feature's routes. */
  | { kind: "mismatch"; url: string; message: string }
  /** The API answered with an error (its error envelope, or a bare status). */
  | {
      kind: "http";
      status: number;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    }
  /** The API answered with a body that does not match the schema. */
  | { kind: "contract"; message: string };

export class ApiRequestError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}

/** Which part of the API a client talks to, for its messages. */
export interface Feature {
  /** e.g. "analytics API" */
  readonly name: string;
  /** e.g. "Phase 4 analytics": an API built before this has none of the feature's routes. */
  readonly since: string;
}

const TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 3000;

/** Our error envelope: `{"error": {"code", "message", "details"}}`. */
function envelope(
  body: unknown,
): { code: string; message?: string; details?: Record<string, unknown> } | null {
  const err = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)
    ?.error;
  return typeof err?.code === "string"
    ? {
        code: err.code,
        message: typeof err.message === "string" ? err.message : undefined,
        details:
          err.details && typeof err.details === "object"
            ? (err.details as Record<string, unknown>)
            : undefined,
      }
    : null;
}

/**
 * A request failed before any response. A browser reports a refused connection and a CORS
 * refusal the same way, so ask again in `no-cors` mode: an opaque answer means the server is up
 * and only CORS stood in the way.
 */
async function diagnoseNoResponse(
  feature: Feature,
  url: string,
  timedOut: boolean,
  timeoutMs: number,
): Promise<ApiFailure> {
  if (timedOut)
    return {
      kind: "offline",
      url: API_URL,
      message: `The ${feature.name} at ${API_URL} did not answer within ${timeoutMs / 1000} s.`,
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

const notOurs = (): ApiFailure => ({
  kind: "mismatch",
  url: API_URL,
  message: `The server at ${API_URL} is not the WAREHOUSE ONE API: its GET /health does not identify it. Another application may be using that port; point the web app at the port the API is published on (API_PORT in .env).`,
});

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Send a request and validate the answer, or throw an ApiRequestError that says why not. */
export async function requestJson<T>(
  feature: Feature,
  path: string,
  schema: z.ZodType<T>,
  { method = "GET", body, signal, timeoutMs = TIMEOUT_MS }: RequestOptions = {},
): Promise<T> {
  const url = `${API_URL}${path}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiRequestError(await diagnoseNoResponse(feature, url, timeout.aborted, timeoutMs));
  }
  let data: unknown = null;
  let json = true;
  try {
    data = await res.json();
  } catch {
    json = false;
  }
  if (!res.ok) {
    const err = envelope(data);
    if (err)
      throw new ApiRequestError({
        kind: "http",
        status: res.status,
        code: err.code,
        message: err.message ?? `The ${feature.name} answered ${res.status}.`,
        details: err.details,
      });
    // No error envelope: an unknown route (FastAPI's default 404), or not our API at all.
    const who = await identify();
    if (!who.ours) throw new ApiRequestError(notOurs());
    if (res.status === 404 || res.status === 405)
      throw new ApiRequestError({
        kind: "mismatch",
        url: API_URL,
        message: `The WAREHOUSE ONE API at ${API_URL} (v${who.version}) has no route ${method} ${path.split("?")[0]}: it was built before ${feature.since}. Rebuild and recreate it: docker compose up -d --build api.`,
      });
    throw new ApiRequestError({
      kind: "http",
      status: res.status,
      code: json ? `HTTP_${res.status}` : "INVALID_JSON",
      message: `The ${feature.name} answered ${res.status}.`,
    });
  }
  const parsed = json ? schema.safeParse(data) : null;
  if (!parsed?.success) {
    if (!(await identify()).ours) throw new ApiRequestError(notOurs());
    const issue = parsed?.error.issues[0];
    throw new ApiRequestError({
      kind: "contract",
      message: parsed
        ? `Unexpected response from ${path}: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim() +
          ". The API and the web app may be from different versions."
        : `The ${feature.name} answered ${res.status} without valid JSON.`,
    });
  }
  return parsed.data;
}
