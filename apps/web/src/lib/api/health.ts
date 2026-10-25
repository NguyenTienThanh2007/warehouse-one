/** Client for the API health endpoints, with explicit states for the UI. */
export type ApiStatus =
  | { kind: "checking" }
  | { kind: "online"; version: string; latencyMs: number; database: "ok" }
  | { kind: "degraded"; version: string; latencyMs: number; database: "unavailable" }
  | { kind: "offline"; reason: string };

/** Resolved by next.config.ts (see base-url.ts); the fallback only applies outside Next.js. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
/** Where API_URL came from, shown next to connection errors. */
export const API_URL_SOURCE = process.env.NEXT_PUBLIC_API_URL_SOURCE ?? "default";
/** What WAREHOUSE ONE's API reports as `service` on GET /health. */
export const API_SERVICE = "warehouse-api";

interface Liveness {
  status: "ok";
  service: typeof API_SERVICE;
  version: string;
}
interface Readiness {
  status: "ready" | "not_ready";
  checks: { database?: { status: "ok" | "unavailable" } };
}

function isLiveness(v: unknown): v is Liveness {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Liveness).status === "ok" &&
    (v as Liveness).service === API_SERVICE &&
    typeof (v as Liveness).version === "string"
  );
}
function isReadiness(v: unknown): v is Readiness {
  return typeof v === "object" && v !== null && typeof (v as Readiness).checks === "object";
}

/** Combine liveness + readiness responses into one UI state. Pure; unit-tested. */
export function interpretHealth(live: unknown, ready: unknown, latencyMs: number): ApiStatus {
  if (!isLiveness(live))
    return { kind: "offline", reason: "Not the WAREHOUSE ONE API (unexpected /health)" };
  const latency = Math.round(latencyMs);
  if (isReadiness(ready) && ready.status === "ready" && ready.checks.database?.status === "ok") {
    return { kind: "online", version: live.version, latencyMs: latency, database: "ok" };
  }
  return { kind: "degraded", version: live.version, latencyMs: latency, database: "unavailable" };
}

export async function fetchApiStatus(baseUrl = API_URL, timeoutMs = 4000): Promise<ApiStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const liveRes = await fetch(`${baseUrl}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    const latency = performance.now() - started;
    if (!liveRes.ok)
      return { kind: "offline", reason: `HTTP ${liveRes.status} from ${baseUrl}/health` };
    const live: unknown = await liveRes.json();
    // /health/ready answers 503 with a JSON body when a dependency is down: still parse it.
    const readyRes = await fetch(`${baseUrl}/health/ready`, {
      signal: controller.signal,
      cache: "no-store",
    });
    const ready: unknown = await readyRes.json().catch(() => null);
    return interpretHealth(live, ready, latency);
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { kind: "offline", reason: aborted ? "Timed out" : "Unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
