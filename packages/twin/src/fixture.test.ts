import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "@warehouse-one/simulation";
import { standbyFixture } from "./fixture";
import type { Evaluation } from "./optimizer";
import { verifyEvaluation } from "./verify";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data/fixtures/twin-standby");
const read = (name: string): unknown => JSON.parse(readFileSync(resolve(dir, name), "utf8"));

describe("golden twin fixture (data/fixtures/twin-standby)", () => {
  // Regenerate with `pnpm fixtures:generate` only for an intended change in the optimiser.
  it("the optimiser reproduces the stored evaluations exactly", async () => {
    const f = await standbyFixture();
    const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
    expect(json(f.snapshot)).toEqual(read("snapshot.json"));
    expect(json(f.recommended)).toEqual(read("evaluation-recommended.json"));
    expect(json(f.unchanged)).toEqual(read("evaluation-unchanged.json"));
    expect(f.recommended.recommendation).not.toBeNull();
    expect(f.unchanged.recommendation).toBeNull();
  }, 120_000);
});

describe("verifying a stored evaluation", () => {
  it("re-running the stored evaluation reproduces it; a changed figure is caught", async () => {
    const snapshot = read("snapshot.json") as Snapshot;
    const stored = read("evaluation-recommended.json") as Evaluation;
    expect(await verifyEvaluation(stored, snapshot)).toMatchObject({ ok: true, mismatches: [] });
    const tampered = JSON.parse(JSON.stringify(stored)) as {
      candidates: { metrics: { empty_km: number } | null }[];
    };
    const c = tampered.candidates.find((x) => x.metrics) as { metrics: { empty_km: number } };
    c.metrics.empty_km += 1;
    const r = await verifyEvaluation(tampered as unknown as Evaluation, snapshot);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toContain("c1.metrics");
  }, 120_000);
});
