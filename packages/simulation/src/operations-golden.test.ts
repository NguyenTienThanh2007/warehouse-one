import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderGoldenFiles } from "./scenarios/golden";
import { runOperationsDemo } from "./scenarios/operations-demo";

const fixturesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../data/fixtures/operations-demo",
);

describe("operations reference fixture (data/fixtures/operations-demo)", () => {
  const run = runOperationsDemo();
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

  it("completes the inbound → storage → outbound flow and the relocation", () => {
    expect(run.summary.orders).toEqual({ "ord-000001": "shipped" });
    expect(run.summary.trucks).toEqual({ "trk-000001": "departed", "trk-000002": "departed" });
    expect(run.summary.tasks_completed_by_type).toEqual({
      load: 4,
      pick: 4,
      putaway: 3,
      relocate: 1,
      unload: 3,
    });
    expect(run.summary.final_pallets["plt-000004"]).toBe("loc-05-012#0");
    expect(Object.keys(run.finalState.ops!.tasks)).toEqual([]);
  });

  it("rejects the scripted invalid commands with the expected codes", () => {
    expect(run.summary.rejection_codes).toEqual({
      "ops-0006": "INSUFFICIENT_STOCK",
      "ops-0007": "PALLET_RESERVED",
      "ops-0008": "UNKNOWN_PALLET",
      "ops-0009": "ORDER_NOT_CANCELLABLE",
    });
  });
});
