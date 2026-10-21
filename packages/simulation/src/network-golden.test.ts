import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderGoldenFiles } from "./scenarios/golden";
import { runNetworkDemo } from "./scenarios/network-demo";

const fixturesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../data/fixtures/network-demo",
);

describe("network reference fixture (data/fixtures/network-demo)", () => {
  const run = runNetworkDemo();
  const files = renderGoldenFiles(run);

  it.each(Object.keys(files))(
    "%s matches the engine output (regenerate with `pnpm fixtures:generate`)",
    (name) => {
      expect(readFileSync(resolve(fixturesDir, name), "utf8")).toBe(files[name]);
    },
  );

  it("keeps every invariant throughout the run", () => {
    expect(run.invariantViolations).toEqual([]);
  });

  it("covers every network event type and the DC hand-over", () => {
    const counts = run.summary.event_counts_by_type as Record<string, number>;
    for (const t of ["transfer.status_changed", "linehaul.status_changed", "site.stock_changed"])
      expect(counts[t]).toBeGreaterThan(0);
    expect(counts["truck.status_changed"]).toBeGreaterThan(0);
    const delivered = run.summary.pallets_delivered_by_lane as Record<string, number>;
    expect(Object.keys(delivered).length).toBeGreaterThan(1);
  });

  it("rejects the scripted invalid requests with the expected codes", () => {
    expect(run.summary.rejection_codes).toEqual({
      "net-0002": "INVALID_TRANSFER",
      "net-0003": "INSUFFICIENT_STOCK",
    });
  });
});
