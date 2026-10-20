import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderGoldenFiles, runGolden } from "./scenarios/golden";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/fixtures/foundation-demo");

describe("golden fixture (data/fixtures/foundation-demo)", () => {
  const run = runGolden();
  const files = renderGoldenFiles(run);

  it.each(Object.keys(files))("%s matches the engine output (regenerate with `pnpm fixtures:generate`)", (name) => {
    expect(readFileSync(resolve(fixturesDir, name), "utf8")).toBe(files[name]);
  });

  it("records the expected rejections for the scripted invalid commands", () => {
    expect(run.summary.rejection_codes).toEqual({
      "op-0002": "CAPACITY_EXCEEDED",
      "op-0004": "INSUFFICIENT_STOCK",
      "op-0006": "UNKNOWN_LOCATION",
    });
  });
});
