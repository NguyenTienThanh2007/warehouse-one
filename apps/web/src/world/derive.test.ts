import {
  createScenario,
  createInitialState,
  step,
  totalsBySku,
  type SimulationConfig,
} from "@warehouse-one/simulation";
import { describe, expect, it } from "vitest";
import {
  archetypeForSku,
  bayBounds,
  derivePallets,
  deriveRackParts,
  levelsFor,
  rackRows,
  resolveFacility,
  sceneCounts,
  slotLocal,
} from "./derive";

const scenario = createScenario("showcase");
const config = scenario.config;
const rack = resolveFacility(config).rack;
const state = step(config, createInitialState(config), scenario.openingCommands).state;
const pallets = derivePallets(config, state.inventory, rack);
const units = Object.values(totalsBySku(state)).reduce((a, b) => a + b, 0);

describe("derivePallets: the scene shows exactly the authoritative inventory", () => {
  it("creates one instance per stored unit and none for empty bays", () => {
    expect(units).toBeGreaterThan(0);
    expect(pallets).toHaveLength(units);
    const empty = config.locations.filter((l) => !state.inventory[l.id]);
    expect(empty.length).toBeGreaterThan(0);
    for (const l of empty) expect(pallets.some((p) => p.locationId === l.id)).toBe(false);
  });

  it("matches per-location, per-SKU quantities", () => {
    const rebuilt: Record<string, Record<string, number>> = {};
    for (const p of pallets) {
      rebuilt[p.locationId] ??= {};
      rebuilt[p.locationId]![p.sku] = (rebuilt[p.locationId]![p.sku] ?? 0) + 1;
    }
    expect(rebuilt).toEqual(state.inventory);
  });

  it("assigns unique slots within capacity, inside the bay footprint", () => {
    const byLoc = new Map(config.locations.map((l) => [l.id, l]));
    const seen = new Set<string>();
    for (const p of pallets) {
      const loc = byLoc.get(p.locationId)!;
      expect(p.slot).toBeLessThan(loc.capacity);
      expect(seen.has(`${p.locationId}:${p.slot}`)).toBe(false);
      seen.add(`${p.locationId}:${p.slot}`);
      const b = bayBounds(loc, rack);
      expect(p.position[0]).toBeGreaterThanOrEqual(b.min.x - 1e-6);
      expect(p.position[0]).toBeLessThanOrEqual(b.max.x + 1e-6);
      expect(p.position[2]).toBeGreaterThanOrEqual(b.min.z - 1e-6);
      expect(p.position[2]).toBeLessThanOrEqual(b.max.z + 1e-6);
    }
  });

  it("is deterministic and fills bottom-up", () => {
    expect(derivePallets(config, state.inventory, rack)).toEqual(pallets);
    expect(slotLocal(0, rack).level).toBe(0);
    expect(slotLocal(rack.positions_per_level, rack).level).toBe(1);
    expect(slotLocal(rack.positions_per_level, rack).y).toBeCloseTo(rack.level_height);
  });

  it("follows the simulation as it changes", () => {
    let s = state;
    for (let i = 0; i < 200; i++) s = step(config, s).state;
    const total = Object.values(totalsBySku(s)).reduce((a, b) => a + b, 0);
    expect(derivePallets(config, s.inventory, rack)).toHaveLength(total);
  });
});

describe("static structure", () => {
  it("groups the showcase into 6 rack rows of 14 bays", () => {
    const rows = rackRows(config);
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.locations).toHaveLength(14);
  });

  it("builds shared upright frames (bays + 1 per row) and beams for every raised level", () => {
    const parts = deriveRackParts(config, rack);
    expect(parts.posts).toHaveLength(6 * 15 * 2);
    const levels = levelsFor(8, rack);
    expect(parts.beams).toHaveLength(config.locations.length * (levels - 1) * 2);
    expect(parts.guards).toHaveLength(6 * 2 * 2);
  });

  it("reports scene counts that equal config and inventory", () => {
    const c = sceneCounts(config, pallets);
    expect(c.pallets).toBe(units);
    expect(c.bays).toBe(84);
    expect(c.vehicles).toBe(config.facility!.equipment.length);
    expect(c.docks).toBe(4);
  });

  it("maps SKUs onto cargo archetypes stably", () => {
    expect(archetypeForSku(config, "sku-cold-chain")).toBe("cold-chain");
    expect(archetypeForSku(config, "sku-unknown")).toBe("cartons");
  });

  it("invents no docks or vehicles for configs without facility data", () => {
    const bare: SimulationConfig = { ...config, facility: undefined };
    const f = resolveFacility(bare);
    expect(f.docks).toEqual([]);
    expect(f.equipment).toEqual([]);
    for (const l of bare.locations) {
      expect(l.position.x).toBeGreaterThan(f.building.min.x);
      expect(l.position.z).toBeLessThan(f.building.max.z);
    }
  });
});
