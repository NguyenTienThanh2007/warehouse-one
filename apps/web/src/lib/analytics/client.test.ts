import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_URL } from "../api/health";
import { AnalyticsError, analyticsApi, type AnalyticsFailure } from "./api";

/**
 * How the client explains a request that produced no data. The browser cannot see why a request
 * failed (a refused connection and a CORS refusal are the same TypeError), so the client asks
 * follow-up questions; these tests answer them with a stubbed fetch.
 */
const dir = resolve(__dirname, "../../../../../tests/e2e/fixtures/analytics");
const fresh: unknown = JSON.parse(readFileSync(resolve(dir, "status-fresh.json"), "utf8"));
const OURS = { status: "ok", service: "warehouse-api", version: "0.1.0" };

type Handler = (url: string, init: RequestInit | undefined) => Response | "refused";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: { url: string; mode?: RequestMode }[];
function serve(handler: Handler) {
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    calls.push({ url: input, mode: init?.mode });
    const r = handler(input, init);
    return r === "refused" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(r);
  });
}

async function failure(): Promise<AnalyticsFailure> {
  try {
    await analyticsApi.status();
  } catch (e) {
    if (e instanceof AnalyticsError) return e.failure;
    throw e;
  }
  throw new Error("expected the request to fail");
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("location", { origin: "http://localhost:3000" });
});
afterEach(() => vi.unstubAllGlobals());

describe("analytics client failures", () => {
  it("loads a valid status", async () => {
    serve(() => json(fresh));
    await expect(analyticsApi.status()).resolves.toMatchObject({ state: "fresh" });
    expect(calls).toEqual([{ url: `${API_URL}/api/v1/analytics/status`, mode: undefined }]);
  });

  it("reports nothing listening as offline", async () => {
    serve(() => "refused");
    expect(await failure()).toEqual({
      kind: "offline",
      url: API_URL,
      message: `Nothing answers at ${API_URL}.`,
    });
  });

  it("reports a CORS refusal as blocked, naming the page origin", async () => {
    // Regression: WAREHOUSE_CORS_ORIGINS=["http://localhost:3100"] in .env blocked the dev server
    // on :3000; the dashboard said the API "cannot be reached" although it was up.
    serve((_, init) =>
      init?.mode === "no-cors" ? new Response(null, { status: 200 }) : "refused",
    );
    const f = await failure();
    expect(f).toMatchObject({ kind: "blocked", url: API_URL, origin: "http://localhost:3000" });
    expect(f.message).toMatch(/answered, but its CORS policy does not allow requests from/);
    expect(calls.map((c) => c.mode)).toEqual([undefined, "no-cors"]);
  });

  it("reports another application on the port as a mismatch", async () => {
    // FastAPI's default 404 (no error envelope) and a /health that is not ours: e.g. :8000.
    serve((url) =>
      url.endsWith("/health")
        ? json({ detail: "Not Found" }, 404)
        : json({ detail: "Not Found" }, 404),
    );
    const f = await failure();
    expect(f.kind).toBe("mismatch");
    expect(f.message).toMatch(/is not the WAREHOUSE ONE API/);
  });

  it("reports our API without analytics routes as an old image", async () => {
    serve((url) => (url.endsWith("/health") ? json(OURS) : json({ detail: "Not Found" }, 404)));
    const f = await failure();
    expect(f.kind).toBe("mismatch");
    expect(f.message).toMatch(/v0\.1\.0\) has no route GET \/api\/v1\/analytics\/status/);
    expect(f.message).toMatch(/docker compose up -d --build api/);
  });

  it("keeps the API's own errors as HTTP errors", async () => {
    serve(() => json({ error: { code: "NO_SNAPSHOT", message: "nothing yet", details: {} } }, 404));
    expect(await failure()).toEqual({
      kind: "http",
      status: 404,
      code: "NO_SNAPSHOT",
      message: "nothing yet",
    });
    expect(calls).toHaveLength(1);
  });

  it("separates a contract mismatch of our API from a foreign 200", async () => {
    serve((url) => (url.endsWith("/health") ? json(OURS) : json({ state: "live" })));
    const ours = await failure();
    expect(ours.kind).toBe("contract");
    expect(ours.message).toMatch(/^Unexpected response from \/api\/v1\/analytics\/status/);

    serve((url) => (url.endsWith("/health") ? json({ ok: true }) : json({ state: "live" })));
    expect((await failure()).kind).toBe("mismatch");
  });

  it("does not turn a caller's cancellation into a failure", async () => {
    serve(() => "refused");
    const ctl = new AbortController();
    ctl.abort();
    await expect(analyticsApi.status(ctl.signal)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
  });
});
