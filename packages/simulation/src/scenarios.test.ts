import { describe, expect, it } from "vitest";
import {
  checkInvariants,
  createBenchmarkScenario,
  createInitialState,
  createScenario,
  SCENARIO_IDS,
  stateHash,
  step,
  STANDARD_RACK,
  totalsBySku,
  validateConfig,
  type Scenario,
  type SimulationConfig,
} from "./index";

function open(s: Scenario) {
  const r = step(s.config, createInitialState(s.config), s.openingCommands);
  return r;
}
const units = (inv: Record<string, number>) => Object.values(inv).reduce((a, b) => a + b, 0);

describe("scenario registry", () => {
  it.each(SCENARIO_IDS)("%s has a valid config and opening commands that all apply", (id) => {
    const s = createScenario(id);
    expect(validateConfig(s.config)).toEqual([]);
    const r = open(s);
    expect(r.rejections).toEqual([]);
    expect(checkInvariants(s.config, r.state)).toEqual([]);
  });

  it("is deterministic", () => {
    const a = open(createScenario("showcase"));
    const b = open(createScenario("showcase"));
    const s = createScenario("showcase");
    expect(stateHash(s.config, a.state)).toBe(stateHash(s.config, b.state));
  });

  it("gives every scenario a distinct simulation_id", () => {
    const ids = SCENARIO_IDS.map((id) => createScenario(id).config.simulation_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("opens the showcase at roughly half capacity and the empty facility with nothing", () => {
    const show = createScenario("showcase");
    const capacity = show.config.locations.reduce((n, l) => n + l.capacity, 0);
    const stored = units(totalsBySku(open(show).state));
    expect(stored / capacity).toBeGreaterThan(0.4);
    expect(stored / capacity).toBeLessThan(0.7);
    expect(units(totalsBySku(open(createScenario("empty")).state))).toBe(0);
  });

  it.each([100, 300, 1000] as const)(
    "bench-%i stores exactly that many pallets and keeps the count under the workload",
    (n) => {
      const s = createBenchmarkScenario(n);
      let state = open(s).state;
      expect(units(totalsBySku(state))).toBe(n);
      for (let i = 0; i < 300; i++) state = step(s.config, state).state;
      expect(units(totalsBySku(state))).toBe(n);
    },
  );
});

describe("generated warehouse layout", () => {
  const { config } = createScenario("showcase");
  const f = config.facility!;

  it("keeps every bay, dock and parked vehicle inside the site and bays inside the building", () => {
    for (const l of config.locations) {
      expect(l.position.x).toBeGreaterThan(f.building.min.x);
      expect(l.position.x).toBeLessThan(f.building.max.x);
    }
    for (const e of f.equipment) {
      expect(e.position.x).toBeGreaterThanOrEqual(f.site.min.x);
      expect(e.position.z).toBeLessThanOrEqual(f.site.max.z);
    }
    for (const d of f.docks) expect(d.position.z).toBe(f.building.max.z);
  });

  it("does not let rack footprints overlap and leaves a working aisle at every pick face", () => {
    const half = STANDARD_RACK.depth / 2;
    const rows = [...new Map(config.locations.map((l) => [l.position.z, l])).values()].sort(
      (a, b) => a.position.z - b.position.z,
    );
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i]!.position.z - half - (rows[i - 1]!.position.z + half);
      expect(gap).toBeGreaterThan(0.2);
      // A gap that two pick faces look into must be a full aisle.
      const facing = rows[i - 1]!.yaw === 0 || rows[i]!.yaw === Math.PI;
      if (facing) expect(gap).toBeGreaterThanOrEqual(3.5);
    }
  });

  it("parks trucks outside on their assigned dock and forklifts inside", () => {
    for (const e of f.equipment) {
      if (e.kind === "truck") {
        const dock = f.docks.find((d) => d.id === e.dock_id)!;
        expect(e.position.x).toBe(dock.position.x);
        expect(e.position.z).toBeGreaterThan(f.building.max.z);
      } else {
        expect(e.position.z).toBeLessThan(f.building.max.z);
      }
    }
  });

  it("rejects invalid facility data", () => {
    const bad: SimulationConfig = {
      ...config,
      facility: {
        ...f,
        docks: [...f.docks, { ...f.docks[0]! }],
        equipment: [
          { ...f.equipment[0]!, kind: "hovercraft" as never },
          { ...f.equipment[0]!, id: "trk-x", dock_id: "dock-99" },
        ],
      },
    };
    const problems = validateConfig(bad);
    expect(problems.some((p) => p.includes("duplicate facility id"))).toBe(true);
    expect(problems.some((p) => p.includes("unknown kind"))).toBe(true);
    expect(problems.some((p) => p.includes("unknown dock"))).toBe(true);
    const outside: SimulationConfig = {
      ...config,
      locations: [{ ...config.locations[0]!, position: { x: 999, z: 0 } }],
    };
    expect(validateConfig(outside).some((p) => p.includes("outside the building"))).toBe(true);
  });
});
