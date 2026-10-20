import { describe, expect, it } from "vitest";
import { nextFloat, nextInt, nextU32, seedRng, type RngState } from "./rng";
import { deterministicUuid, hashValue, stableStringify } from "./hash";

function draw(state: RngState, n: number): number[] {
  const out: number[] = [];
  let s = state;
  for (let i = 0; i < n; i++) {
    const [v, next] = nextU32(s);
    out.push(v);
    s = next;
  }
  return out;
}

describe("seeded RNG", () => {
  it("produces the same stream for the same seed", () => {
    expect(draw(seedRng("abc"), 100)).toEqual(draw(seedRng("abc"), 100));
  });

  it("produces different streams for different seeds", () => {
    expect(draw(seedRng("abc"), 10)).not.toEqual(draw(seedRng("abd"), 10));
  });

  it("is pinned to known values so engine output cannot drift silently", () => {
    expect(draw(seedRng("warehouse-one"), 3)).toMatchInlineSnapshot(`
      [
        966504573,
        3773475828,
        2470618552,
      ]
    `);
  });

  it("keeps floats in [0,1) and ints within inclusive bounds with roughly uniform spread", () => {
    let s = seedRng("dist");
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 20_000; i++) {
      const [f, n1] = nextFloat(s);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const [k, n2] = nextInt(n1, 0, 9);
      buckets[k]++;
      s = n2;
    }
    for (const b of buckets) expect(b).toBeGreaterThan(1700); // expected 2000 each
  });

  it("rejects invalid integer ranges", () => {
    expect(() => nextInt(seedRng("x"), 5, 1)).toThrow(RangeError);
  });
});

describe("hashing", () => {
  it("is independent of object key order", () => {
    expect(hashValue({ a: 1, b: { c: 2, d: 3 } })).toBe(hashValue({ b: { d: 3, c: 2 }, a: 1 }));
    expect(stableStringify({ b: 1, a: [2, { z: 1, y: 2 }] })).toBe('{"a":[2,{"y":2,"z":1}],"b":1}');
  });

  it("refuses non-finite numbers rather than hashing them as null", () => {
    expect(() => stableStringify({ x: NaN })).toThrow();
  });

  it("derives stable, valid, unique version-8 UUIDs", () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = new Set<string>();
    for (let i = 1; i <= 5000; i++) {
      const id = deterministicUuid("sim", i);
      expect(id).toMatch(re);
      ids.add(id);
    }
    expect(ids.size).toBe(5000);
    expect(deterministicUuid("sim", 42)).toBe(deterministicUuid("sim", 42));
    expect(deterministicUuid("sim-a", 1)).not.toBe(deterministicUuid("sim-b", 1));
  });
});
