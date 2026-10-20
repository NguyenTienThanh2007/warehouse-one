import type { BufferGeometry } from "three";
import { describe, expect, it } from "vitest";
import { CARGO_ARCHETYPES } from "./derive";
import {
  beamGeometry,
  cargoGeometry,
  forkliftModel,
  palletGeometry,
  PALLET,
  reachTruckModel,
  truckModel,
} from "./geometry";

const tris = (g: BufferGeometry) =>
  (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;

describe("procedural assets", () => {
  it("keep per-instance triangle budgets so 1,000 pallets stay cheap", () => {
    expect(tris(palletGeometry())).toBeLessThanOrEqual(300);
    for (const a of CARGO_ARCHETYPES) expect(tris(cargoGeometry(a)), a).toBeLessThanOrEqual(800);
    expect(tris(beamGeometry())).toBeLessThanOrEqual(12);
  });

  it("are built at real-world scale", () => {
    const p = palletGeometry().boundingBox!;
    expect(p.max.x - p.min.x).toBeCloseTo(PALLET.width, 2);
    expect(p.max.z - p.min.z).toBeCloseTo(PALLET.depth, 2);
    for (const a of CARGO_ARCHETYPES) {
      const b = cargoGeometry(a).boundingBox!;
      // Loads fit within the 1.6 m beam pitch (minus beam and lift clearance) and the pallet footprint.
      expect(b.max.y, a).toBeLessThan(1.42);
      expect(b.max.x - b.min.x, a).toBeLessThanOrEqual(1.05);
    }
    const truck = truckModel();
    const t = truck.body!.boundingBox!;
    expect(t.max.z - t.min.z).toBeGreaterThan(14);
    expect(t.max.y).toBeLessThan(4.1);
  });

  it("give every vehicle a body, tyres and steel parts", () => {
    for (const m of [forkliftModel(), reachTruckModel(), truckModel()]) {
      expect(m.body).toBeDefined();
      expect(m.tyre).toBeDefined();
      expect(m.steel).toBeDefined();
    }
  });
});
