import { describe, expect, it } from "vitest";
import { interpretHealth } from "./health";

const live = { status: "ok", service: "warehouse-api", version: "0.1.0" };

describe("interpretHealth", () => {
  it("is online when the database check passes", () => {
    expect(
      interpretHealth(live, { status: "ready", checks: { database: { status: "ok" } } }, 12.4),
    ).toEqual({
      kind: "online",
      version: "0.1.0",
      latencyMs: 12,
      database: "ok",
    });
  });

  it("is degraded when the API is up but not ready", () => {
    const r = interpretHealth(
      live,
      { status: "not_ready", checks: { database: { status: "unavailable" } } },
      5,
    );
    expect(r.kind).toBe("degraded");
  });

  it("is degraded when readiness cannot be parsed", () => {
    expect(interpretHealth(live, null, 5).kind).toBe("degraded");
  });

  it("is offline on an unexpected liveness payload", () => {
    expect(interpretHealth({ hello: "world" }, null, 5).kind).toBe("offline");
  });

  it("is offline when another service answers /health", () => {
    // Another application on the configured port must never count as this API.
    const other = { status: "ok", service: "f01-api", version: "2.0.0" };
    expect(
      interpretHealth(other, { status: "ready", checks: { database: { status: "ok" } } }, 5),
    ).toEqual({ kind: "offline", reason: "Not the WAREHOUSE ONE API (unexpected /health)" });
    expect(interpretHealth({ status: "ok", version: "1" }, null, 5).kind).toBe("offline");
  });
});
