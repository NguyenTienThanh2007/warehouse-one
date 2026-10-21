import {
  createInitialState,
  createNetworkScenario,
  createScenario,
  linehaulPose,
  step,
  type SimulationState,
} from "@warehouse-one/simulation";
import { describe, expect, it } from "vitest";
import { buildNetworkStatic } from "./network-geometry";
import {
  containerSlots,
  DEFAULT_SITE_ID,
  floorPallets,
  floorSlots,
  linehaulViews,
  networkSummary,
  primarySiteId,
  resolveSites,
  roadSegments,
  siteActivity,
  worldBounds,
} from "./network-view";

const scenario = createNetworkScenario();
const config = scenario.config;

function run(ticks: number): { prev: SimulationState; state: SimulationState } {
  let state = step(config, createInitialState(config), scenario.openingCommands).state;
  let prev = state;
  for (let i = 0; i < ticks; i++) {
    prev = state;
    state = step(config, state).state;
  }
  return { prev, state };
}

describe("sites", () => {
  it("lists every network site with a stable id, the DC first and primary", () => {
    const sites = resolveSites(config);
    expect(sites.map((s) => s.id)).toEqual([
      "northgate-dc",
      "harbour-terminal",
      "riverside-xd",
      "fleet-depot",
      "east-gateway",
    ]);
    expect(sites.filter((s) => s.primary).map((s) => s.id)).toEqual(["northgate-dc"]);
    expect(primarySiteId(config)).toBe("northgate-dc");
  });

  it("gives single-site scenarios one default site: the facility itself", () => {
    const single = createScenario("showcase").config;
    const sites = resolveSites(single);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      id: DEFAULT_SITE_ID,
      kind: "distribution_center",
      primary: true,
    });
    expect(sites[0]?.bounds).toEqual(single.facility?.site);
    expect(primarySiteId(single)).toBe(DEFAULT_SITE_ID);
    expect(worldBounds(single)).toEqual(single.facility?.site);
    expect(roadSegments(single)).toEqual([]);
  });

  it("bounds the world around every site and road", () => {
    const w = worldBounds(config);
    for (const s of resolveSites(config)) {
      expect(s.bounds.min.x).toBeGreaterThanOrEqual(w.min.x);
      expect(s.bounds.max.z).toBeLessThanOrEqual(w.max.z);
    }
    for (const r of roadSegments(config)) {
      expect(r.length).toBeGreaterThan(0);
      for (const p of [r.a, r.b]) {
        expect(p.x).toBeGreaterThanOrEqual(w.min.x);
        expect(p.x).toBeLessThanOrEqual(w.max.x);
      }
    }
  });
});

describe("static geometry", () => {
  const built = buildNetworkStatic(config);

  it("builds roads, pads, buildings and cranes from the layout, merged per material", () => {
    for (const key of ["road", "roadService", "marking", "pad", "craneYellow", "craneBlue", "tree"])
      expect(built.meshes[key], key).toBeDefined();
    // Roofs and cut-away walls exist for every building with an interior.
    const interiors = config.network!.sites.flatMap((s) =>
      s.buildings.filter(
        (b) => b.style === "cross_dock" || b.style === "cfs_shed" || b.style === "workshop",
      ),
    );
    expect(built.roofs.map((r) => r.building).sort()).toEqual(interiors.map((b) => b.id).sort());
    expect(built.walls).toHaveLength(interiors.length * 4);
  });

  it("puts a status light at every dock door of the network (and only there)", () => {
    const doors = config.network!.sites.flatMap((s) => s.stands.filter((x) => x.kind === "door"));
    expect(built.doorLights.map((l) => l.stand).sort()).toEqual(doors.map((d) => d.id).sort());
  });

  it("is cheap enough to build on every scenario load", () => {
    const t0 = performance.now();
    buildNetworkStatic(config);
    expect(performance.now() - t0).toBeLessThan(1500);
    let triangles = 0;
    for (const g of Object.values(built.meshes))
      triangles += (g.index?.count ?? g.attributes.position!.count) / 3;
    for (const w of built.walls) triangles += w.full.attributes.position!.count / 3;
    // Budget for the whole network around the DC (racks and pallets are budgeted separately).
    expect(triangles).toBeLessThan(250_000);
  });
});

describe("state-driven views", () => {
  const { prev, state } = run(1500);

  it("draws exactly the trucks the network draws, at their authoritative poses", () => {
    const views = linehaulViews(config, undefined, state, 1);
    const expected = Object.values(state.network!.vehicles)
      .map((v) => ({ id: v.id, pose: linehaulPose(config, state, v) }))
      .filter((v) => v.pose !== null);
    expect(views.map((v) => v.id)).toEqual(expected.map((v) => v.id));
    for (const v of views) expect(v.pose).toEqual(expected.find((e) => e.id === v.id)?.pose);
  });

  it("interpolates between the last two ticks", () => {
    const half = linehaulViews(config, prev, state, 0.5);
    const now = linehaulViews(config, prev, state, 1);
    const before = linehaulViews(config, undefined, prev, 1);
    for (const v of half) {
      const a = before.find((x) => x.id === v.id);
      const b = now.find((x) => x.id === v.id);
      if (!a || !b) continue;
      expect(v.pose.x).toBeCloseTo((a.pose.x + b.pose.x) / 2, 6);
      expect(v.pose.z).toBeCloseTo((a.pose.z + b.pose.z) / 2, 6);
    }
  });

  it("lays every pallet a site holds on its floor, one slot each", () => {
    for (const site of resolveSites(config).filter((s) => s.palletCapacity > 0)) {
      const slots = floorSlots(site);
      expect(slots.length).toBeGreaterThanOrEqual(site.palletCapacity);
      const unique = new Set(slots.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)},${s.level}`));
      expect(unique.size).toBe(slots.length);
      const stock = state.network!.sites[site.id]!.stock;
      const drawn = floorPallets(config, site, stock);
      expect(drawn.length).toBe(Object.values(stock).reduce((a, b) => a + b, 0));
      // Inside the hall.
      const hall = site.buildings.find((b) => b.style === "cross_dock" || b.style === "cfs_shed")!;
      for (const p of drawn) {
        expect(p.x).toBeGreaterThan(hall.min.x);
        expect(p.x).toBeLessThan(hall.max.x);
        expect(p.z).toBeGreaterThan(hall.min.z);
        expect(p.z).toBeLessThan(hall.max.z);
      }
    }
  });

  it("has room in the stacks for every container the terminal can hold", () => {
    const terminal = resolveSites(config).find((s) => s.containers)!;
    const slots = containerSlots(terminal.containers!);
    expect(slots.length).toBeGreaterThanOrEqual(terminal.containers!.capacity);
    expect(new Set(slots.map((s) => s.key)).size).toBe(slots.length);
    // Lowest tiers fill first, so a partial yard never floats.
    const tiers = slots.map((s) => s.y);
    for (let i = 1; i < tiers.length; i++) expect(tiers[i]).toBeGreaterThanOrEqual(tiers[i - 1]!);
  });

  it("summarises activity per site and for the whole network from state", () => {
    const xd = siteActivity(config, state, "riverside-xd")!;
    const s = state.network!.sites["riverside-xd"]!;
    expect(xd.pallets).toBe(Object.values(s.stock).reduce((a, b) => a + b, 0));
    expect(xd.doors).toBe(12);
    expect(xd.received).toBe(s.received);
    const n = networkSummary(state)!;
    expect(n.trucks).toBe(6);
    expect(n.activeTransfers).toBe(Object.keys(state.network!.transfers).length);
    expect(siteActivity(createScenario("showcase").config, state, "riverside-xd")).toBeNull();
  });
});
