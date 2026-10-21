import { describe, expect, it } from "vitest";
import { createScenario, SCENARIO_IDS } from "../index";
import {
  findPath,
  headingBetween,
  navGraph,
  pathLength,
  shortestPaths,
  VEHICLE_CLEARANCE,
} from "./nav";
import { STAGING_LANE_CAPACITY } from "./model";

describe.each(SCENARIO_IDS)("navigation graph for %s", (id) => {
  const { config } = createScenario(id);
  const g = navGraph(config);

  it("is valid: connected, axis-aligned, inside the building and clear of every rack", () => {
    expect(g.problems).toEqual([]);
  });

  it("gives every bay a pick node, every dock a full lane and door, every vehicle a charger", () => {
    for (const l of config.locations)
      expect(g.nodes.has(g.pickNode.get(l.id) as string)).toBe(true);
    for (const d of config.facility!.docks) {
      expect(g.laneNodes.get(d.id)).toHaveLength(STAGING_LANE_CAPACITY);
      expect(g.doorNode.has(d.id)).toBe(true);
    }
    for (const e of config.facility!.equipment.filter((v) => v.kind !== "truck"))
      expect(g.chargerNode.has(e.id)).toBe(true);
  });

  it("keeps staging pallets off every travel line", () => {
    for (const spots of g.stagingSpots.values()) {
      for (const s of spots) {
        for (const [a, edges] of g.adjacency) {
          for (const e of edges) {
            const na = g.nodes.get(a)!;
            const nb = g.nodes.get(e.to)!;
            const dx = Math.max(Math.min(na.x, nb.x) - s.x, 0, s.x - Math.max(na.x, nb.x));
            const dz = Math.max(Math.min(na.z, nb.z) - s.z, 0, s.z - Math.max(na.z, nb.z));
            // Pallet half-width (500) plus vehicle clearance.
            expect(Math.max(dx, dz)).toBeGreaterThanOrEqual(500 + VEHICLE_CLEARANCE - 100);
          }
        }
      }
    }
  });
});

describe("routing", () => {
  const { config } = createScenario("showcase");
  const g = navGraph(config);
  const charger = g.chargerNode.get("fl-01")!;
  const target = g.pickNode.get("loc-00-007")!;

  it("finds the shortest path and is deterministic", () => {
    const p1 = findPath(g, charger, target)!;
    const p2 = findPath(g, charger, target)!;
    expect(p1).toEqual(p2);
    expect(p1.at(-1)).toBe(target);
    expect(pathLength(g, charger, p1)).toBe(shortestPaths(g, charger).distance.get(target));
    // Consecutive nodes are adjacent.
    let prev = charger;
    for (const n of p1) {
      expect(g.adjacency.get(prev)!.some((e) => e.to === n)).toBe(true);
      prev = n;
    }
  });

  it("never routes through an avoided node, finds alternatives where the one-way network has them", () => {
    const direct = findPath(g, charger, target)!;
    for (const blocker of direct.slice(0, -1)) {
      const around = findPath(g, charger, target, new Set([blocker]));
      if (around) expect(around).not.toContain(blocker);
    }
    // Some steps of the trip to the east docks can be avoided by going round another aisle.
    const door = g.doorNode.get("dock-04")!;
    const toDoor = findPath(g, charger, door)!;
    const avoidable = toDoor
      .slice(0, -1)
      .filter((n) => findPath(g, charger, door, new Set([n])) !== null);
    expect(avoidable.length).toBeGreaterThan(0);
    expect(findPath(g, charger, target, new Set([target]))).toBeNull();
  });

  it("uses the dock path as a dead end ending at the door", () => {
    const door = g.doorNode.get("dock-02")!;
    const path = findPath(g, charger, door)!;
    const lane = g.laneNodes.get("dock-02")!;
    // Enters at the deepest lane node and walks towards the door.
    expect(path.slice(-STAGING_LANE_CAPACITY - 1)).toEqual([...[...lane].reverse(), door]);
    for (const n of [...lane, door]) expect(g.nodes.get(n)!.zone).toBe("dock:dock-02");
  });

  it("derives headings from axis-aligned edges", () => {
    const a = { id: "a", x: 0, z: 0, kind: "aisle" as const, zone: null };
    expect(headingBetween(a, { ...a, x: 5 })).toBe("px");
    expect(headingBetween(a, { ...a, x: -5 })).toBe("nx");
    expect(headingBetween(a, { ...a, z: 5 })).toBe("pz");
    expect(headingBetween(a, { ...a, z: -5 })).toBe("nz");
  });
});
