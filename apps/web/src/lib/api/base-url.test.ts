import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "./base-url";

describe("resolveApiUrl", () => {
  it("prefers NEXT_PUBLIC_API_URL from the environment", () => {
    expect(
      resolveApiUrl(
        { NEXT_PUBLIC_API_URL: "http://localhost:8010/" },
        { NEXT_PUBLIC_API_URL: "http://localhost:9999", API_PORT: "8010" },
      ),
    ).toEqual({ url: "http://localhost:8010", source: "environment", warnings: [] });
  });

  it("reads the repository .env, so `pnpm dev` follows the Compose ports", () => {
    // Regression: Next.js reads apps/web/.env* only, so the root .env (API_PORT=8010,
    // NEXT_PUBLIC_API_URL=http://localhost:8010) was ignored and `pnpm dev` fell back to :8000,
    // where another application answered.
    expect(
      resolveApiUrl({}, { NEXT_PUBLIC_API_URL: "http://localhost:8010", API_PORT: "8010" }),
    ).toEqual({ url: "http://localhost:8010", source: "repository .env", warnings: [] });
  });

  it("derives the URL from API_PORT when no URL is set", () => {
    expect(resolveApiUrl({}, { API_PORT: "8010" })).toMatchObject({
      url: "http://localhost:8010",
      source: "API_PORT",
    });
    expect(resolveApiUrl({ API_PORT: "8020" }, { API_PORT: "8010" }).url).toBe(
      "http://localhost:8020",
    );
  });

  it("falls back to the Compose default port", () => {
    expect(resolveApiUrl({}, {})).toEqual({
      url: "http://localhost:8000",
      source: "default",
      warnings: [],
    });
    expect(resolveApiUrl({ NEXT_PUBLIC_API_URL: "  " }, {}).source).toBe("default");
  });

  it("warns when a local URL does not use the published API port", () => {
    const r = resolveApiUrl({ NEXT_PUBLIC_API_URL: "http://localhost:8000" }, { API_PORT: "8010" });
    expect(r.url).toBe("http://localhost:8000");
    expect(r.warnings).toEqual([
      "The API URL http://localhost:8000 (environment) does not use API_PORT=8010, the host port Docker Compose publishes the API on.",
    ]);
    // A remote API is not expected to use the local port.
    expect(
      resolveApiUrl({ NEXT_PUBLIC_API_URL: "https://api.example.test" }, { API_PORT: "8010" })
        .warnings,
    ).toEqual([]);
  });

  it("rejects malformed configuration with a message naming the setting", () => {
    expect(() => resolveApiUrl({ NEXT_PUBLIC_API_URL: "localhost:8010" }, {})).toThrow(
      /NEXT_PUBLIC_API_URL must be an http\(s\) URL/,
    );
    expect(() => resolveApiUrl({ NEXT_PUBLIC_API_URL: "8010" }, {})).toThrow(
      /NEXT_PUBLIC_API_URL is not a URL/,
    );
    expect(() => resolveApiUrl({}, { NEXT_PUBLIC_API_URL: "http://x/?a=1" })).toThrow(
      /in \.env must not have a query/,
    );
    expect(() => resolveApiUrl({}, { API_PORT: "80a" })).toThrow(/API_PORT must be a TCP port/);
  });
});
