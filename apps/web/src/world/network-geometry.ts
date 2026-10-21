/**
 * Static geometry of the logistics network, built once per config from layout data: roads and
 * markings, site pads, fences, buildings (walls cut around their real doors), cranes, quay,
 * landscaping and lighting. Everything is merged per material, so the whole network costs a few
 * dozen draw calls. Roofs are kept per building so the facility view can cut them away.
 */
import type { SimulationConfig, SiteBuildingConfig, StandConfig } from "@warehouse-one/simulation";
import { TRUCK_LENGTH } from "@warehouse-one/simulation";
import type { BufferGeometry } from "three";
import { YARD_LEVEL, type Bounds } from "./derive";
import { box, cyl, merge, type Xyz } from "./geometry";
import {
  blockBounds,
  CONTAINER,
  junctions,
  resolveSites,
  ROAD_WIDTH,
  roadSegments,
  worldBounds,
  type RoadSegment,
  type SiteView,
} from "./network-view";

const G = YARD_LEVEL;
const HALF = TRUCK_LENGTH / 2;
export const DOCK_DOOR = { width: 3.0, height: 3.2 } as const;
const SERVICE_DOOR = { width: 4.6, height: 5.2 } as const;
const WALL = 0.25;
const KNEE = 1.1;

type Parts = BufferGeometry[];

class Bucket {
  private readonly parts = new Map<string, Parts>();
  add(key: string, ...g: BufferGeometry[]) {
    const list = this.parts.get(key) ?? [];
    list.push(...g);
    this.parts.set(key, list);
  }
  build(): Record<string, BufferGeometry> {
    const out: Record<string, BufferGeometry> = {};
    for (const [k, v] of this.parts) if (v.length) out[k] = merge(v);
    return out;
  }
}

/** A box between two points on the ground plane (a strip of `width` along a→b). */
function strip(
  a: { x: number; z: number },
  b: { x: number; z: number },
  width: number,
  y: number,
  thickness = 0.02,
): BufferGeometry {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const yaw = Math.atan2(b.x - a.x, b.z - a.z);
  return box(width, thickness, len, [(a.x + b.x) / 2, y, (a.z + b.z) / 2], [0, yaw, 0]);
}

const along = (s: RoadSegment, d: number) => ({
  x: s.a.x + ((s.b.x - s.a.x) * d) / s.length,
  z: s.a.z + ((s.b.z - s.a.z) * d) / s.length,
});
const offset = (p: { x: number; z: number }, yaw: number, d: number) => ({
  x: p.x - Math.cos(yaw) * d,
  z: p.z + Math.sin(yaw) * d,
});

const inside = (b: Bounds, p: { x: number; z: number }, pad = 0) =>
  p.x >= b.min.x - pad && p.x <= b.max.x + pad && p.z >= b.min.z - pad && p.z <= b.max.z + pad;

function distToSegment(p: { x: number; z: number }, s: RoadSegment): number {
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - s.a.x) * (s.b.x - s.a.x) + (p.z - s.a.z) * (s.b.z - s.a.z)) / (s.length * s.length),
    ),
  );
  return Math.hypot(p.x - (s.a.x + (s.b.x - s.a.x) * t), p.z - (s.a.z + (s.b.z - s.a.z) * t));
}

/** One wall of a building with an interior: full height, and the knee wall shown in a cutaway. */
export interface CutawayWall {
  readonly site: string;
  readonly building: string;
  /** Outward normal and centre on the ground plane. */
  readonly normal: readonly [number, number];
  readonly center: readonly [number, number];
  readonly full: BufferGeometry;
  readonly knee: BufferGeometry | null;
}

export interface NetworkStatic {
  /** material key -> merged geometry */
  readonly meshes: Record<string, BufferGeometry>;
  /** Walls of halls and the workshop: camera-facing ones drop to knee height in a facility view. */
  readonly walls: CutawayWall[];
  /** building id -> roof geometry (hidden in that site's facility view) */
  readonly roofs: { site: string; building: string; geometry: BufferGeometry }[];
  /** Door status light positions (state decides the colour). */
  readonly doorLights: { stand: string; site: string; position: Xyz }[];
  readonly world: Bounds;
}

export function buildNetworkStatic(config: SimulationConfig): NetworkStatic {
  const bucket = new Bucket();
  const sites = resolveSites(config);
  const roads = roadSegments(config);
  const world = worldBounds(config);
  const facility = config.facility;
  const avenue = roads.filter((r) => r.kind === "arterial");
  const waterEdge = Math.min(...sites.map((s) => s.bounds.min.x));
  const hasQuay = sites.some((s) => s.containers);

  // --- Ground ---------------------------------------------------------------------------------
  const far = 900;
  const gx0 = hasQuay ? waterEdge : world.min.x - far;
  const gx1 = world.max.x + far;
  bucket.add(
    "terrain",
    box(gx1 - gx0, 0.1, world.max.z - world.min.z + 2 * far, [
      (gx0 + gx1) / 2,
      G - 0.11,
      (world.min.z + world.max.z) / 2,
    ]),
  );
  if (hasQuay) {
    bucket.add(
      "water",
      box(1400, 0.1, 2400, [waterEdge - 700, G - 2.2, (world.min.z + world.max.z) / 2]),
    );
    bucket.add(
      "quay",
      box(2.5, 3, world.max.z - world.min.z + 2 * far, [
        waterEdge - 1.25,
        G - 1.5,
        (world.min.z + world.max.z) / 2,
      ]),
    );
  }

  // --- Roads ----------------------------------------------------------------------------------
  for (const r of roads) {
    const w = ROAD_WIDTH[r.kind];
    const ext = { x: (r.b.x - r.a.x) / r.length, z: (r.b.z - r.a.z) / r.length };
    const a = { x: r.a.x - (ext.x * w) / 2, z: r.a.z - (ext.z * w) / 2 };
    const b = { x: r.b.x + (ext.x * w) / 2, z: r.b.z + (ext.z * w) / 2 };
    bucket.add(
      r.kind === "arterial" ? "road" : "roadService",
      strip(a, b, w, G + (r.kind === "arterial" ? 0.016 : 0.012)),
    );
    // Markings stop short of nodes, where roads meet.
    const gap = 8;
    const mark = G + 0.032;
    for (let d = gap; d + 3 <= r.length - gap; d += 8)
      bucket.add("marking", strip(along(r, d), along(r, d + 3), 0.15, mark));
    if (r.kind === "arterial" && r.length > 2 * gap) {
      for (const side of [-1, 1]) {
        const e = (w / 2 - 0.45) * side;
        bucket.add(
          "marking",
          strip(
            offset(along(r, gap), r.yaw, e),
            offset(along(r, r.length - gap), r.yaw, e),
            0.15,
            mark,
          ),
        );
      }
    }
  }
  for (const j of junctions(config)) {
    const w = ROAD_WIDTH[j.kind];
    bucket.add(
      j.kind === "arterial" ? "road" : "roadService",
      box(w, 0.02, w, [j.x, G + 0.014, j.z]),
    );
  }
  // The highway continues beyond the gateway, out of the modelled world.
  const gateway = sites.find((s) => s.kind === "gateway");
  const exitNode = config.network?.nodes.find(
    (n) => n.id === config.network?.sites.find((s) => s.kind === "gateway")?.gate_node,
  );
  if (gateway && exitNode) {
    const a = exitNode.position;
    const b = { x: a.x + far, z: a.z };
    bucket.add("road", strip(a, b, ROAD_WIDTH.arterial, G + 0.016));
    const hw: RoadSegment = {
      id: "highway",
      kind: "arterial",
      a,
      b,
      length: far,
      yaw: Math.PI / 2,
    };
    for (let d = 4; d < far; d += 8)
      bucket.add("marking", strip(along(hw, d), along(hw, d + 3), 0.15, G + 0.032));
    for (const side of [-1, 1])
      bucket.add(
        "marking",
        strip(
          offset(a, Math.PI / 2, (ROAD_WIDTH.arterial / 2 - 0.45) * side),
          offset(b, Math.PI / 2, (ROAD_WIDTH.arterial / 2 - 0.45) * side),
          0.15,
          G + 0.032,
        ),
      );
    // Overhead sign gantry over the carriageway.
    const gx = a.x - 18;
    for (const side of [-1, 1]) bucket.add("trim", box(0.5, 8, 0.5, [gx, G + 4, a.z + side * 7]));
    bucket.add("trim", box(0.8, 0.8, 15, [gx, G + 7.6, a.z]));
    bucket.add("sign", box(0.25, 2.4, 9, [gx - 0.5, G + 6.4, a.z]));
  }

  // --- Sites: pads, fences, stall markings ----------------------------------------------------
  const crossings = (s: SiteView) => {
    const out: { edge: string; at: number }[] = [];
    const b = s.bounds;
    const edges: [string, "x" | "z", number, number, number][] = [
      ["n", "z", b.min.z, b.min.x, b.max.x],
      ["s", "z", b.max.z, b.min.x, b.max.x],
      ["w", "x", b.min.x, b.min.z, b.max.z],
      ["e", "x", b.max.x, b.min.z, b.max.z],
    ];
    for (const r of roads)
      for (const [edge, axis, v, lo, hi] of edges) {
        const a0 = axis === "z" ? r.a.z : r.a.x;
        const b0 = axis === "z" ? r.b.z : r.b.x;
        if ((a0 - v) * (b0 - v) > 0 || a0 === b0) continue;
        const t = (v - a0) / (b0 - a0);
        const at = axis === "z" ? r.a.x + (r.b.x - r.a.x) * t : r.a.z + (r.b.z - r.a.z) * t;
        if (at >= lo && at <= hi) out.push({ edge, at });
      }
    return out;
  };
  for (const s of sites) {
    if (s.kind === "gateway") continue;
    const b = s.bounds;
    if (s.primary && facility) {
      // The DC's own yard is drawn by the facility; pave its marshalling yard and exit apron.
      if (b.max.x > facility.site.max.x + 0.5)
        bucket.add(
          "pad",
          box(b.max.x - facility.site.max.x, 0.02, b.max.z - b.min.z, [
            (b.max.x + facility.site.max.x) / 2,
            G + 0.006,
            (b.min.z + b.max.z) / 2,
          ]),
        );
      const apronEnd =
        Math.min(
          ...avenue.map((r) => Math.min(r.a.z, r.b.z)).filter((z) => z > facility.site.max.z),
        ) -
        ROAD_WIDTH.arterial / 2;
      if (Number.isFinite(apronEnd))
        bucket.add(
          "pad",
          box(
            facility.site.max.x - facility.site.min.x,
            0.02,
            apronEnd - facility.site.max.z + 0.5,
            [
              (facility.site.min.x + facility.site.max.x) / 2,
              G + 0.004,
              (facility.site.max.z + apronEnd) / 2,
            ],
          ),
        );
    } else {
      bucket.add(
        s.kind === "fleet_depot" ? "padDark" : "pad",
        box(b.max.x - b.min.x, 0.02, b.max.z - b.min.z, [
          (b.min.x + b.max.x) / 2,
          G + 0.006,
          (b.min.z + b.max.z) / 2,
        ]),
      );
      fence(bucket, s, crossings(s));
    }
    for (const st of s.stands) stallMarking(bucket, st);
    lampsAround(bucket, s);
  }

  // --- Buildings ------------------------------------------------------------------------------
  const roofs: NetworkStatic["roofs"] = [];
  const doorLights: NetworkStatic["doorLights"] = [];
  const walls: CutawayWall[] = [];
  for (const s of sites)
    for (const b of s.buildings) {
      const roof = building(bucket, s, b, doorLights, walls);
      if (roof) roofs.push({ site: s.id, building: b.id, geometry: roof });
    }

  // --- Container terminal ---------------------------------------------------------------------
  for (const s of sites) {
    const c = s.containers;
    if (!c) continue;
    for (const blk of c.blocks) {
      const bb = blockBounds(blk);
      const h = blk.tiers * CONTAINER.height + 4.5;
      const z0 = bb.min.z - 2.4;
      const z1 = bb.max.z + 2.4;
      // One rubber-tyred gantry crane per block, parked at the block's west end.
      const x = bb.min.x + 7;
      for (const dx of [-3.4, 3.4]) {
        for (const z of [z0, z1]) {
          bucket.add("craneYellow", box(0.7, h, 0.7, [x + dx, G + h / 2, z]));
          bucket.add("tyre", box(0.6, 1.1, 1.4, [x + dx, G + 0.55, z]));
        }
        bucket.add("craneYellow", box(0.8, 1.3, z1 - z0 + 0.7, [x + dx, G + h, (z0 + z1) / 2]));
        bucket.add("craneYellow", box(0.5, 0.6, z1 - z0, [x + dx, G + 1.4, (z0 + z1) / 2]));
      }
      for (const z of [z0, z1]) bucket.add("craneYellow", box(7.5, 1.0, 0.8, [x, G + h - 0.2, z]));
      bucket.add("trim", box(4.2, 1.6, 3.2, [x, G + h - 1.4, (z0 + z1) / 2]));
    }
    // Ship-to-shore cranes on the quay edge, booms over the water.
    if (hasQuay) {
      const qx = waterEdge;
      for (const z of [s.bounds.min.z + 25, s.bounds.min.z + 75]) {
        for (const dz of [-8, 8]) {
          bucket.add("craneBlue", box(1.2, 32, 1.2, [qx + 5, G + 16, z + dz]));
          bucket.add("craneBlue", box(1.2, 32, 1.2, [qx + 23, G + 16, z + dz]));
          bucket.add("craneBlue", box(19, 1.4, 1.2, [qx + 14, G + 8, z + dz]));
          bucket.add("craneBlue", box(1.0, 14, 1.0, [qx + 14, G + 40, z + dz], [0, 0, 0.35]));
          bucket.add("craneBlue", box(64, 1.6, 1.4, [qx - 10, G + 34, z + dz]));
        }
        bucket.add("craneBlue", box(20, 1.4, 17.4, [qx + 14, G + 32, z]));
        bucket.add("trim", box(6, 3.2, 5, [qx + 18, G + 36.2, z]));
        for (const dz of [-8, 8]) bucket.add("tyre", box(3, 1, 2.2, [qx + 5, G + 0.5, z + dz]));
      }
    }
  }

  // --- Landscaping: trees along the arterial roads, outside sites and clear of other roads ---
  for (const r of avenue) {
    const w = ROAD_WIDTH.arterial;
    for (let d = 6; d < r.length - 6; d += 15)
      for (const side of [-1, 1]) {
        const p = offset(along(r, d), r.yaw, side * (w / 2 + 6));
        if (sites.some((s) => inside(s.bounds, p, 4))) continue;
        if (roads.some((o) => o !== r && distToSegment(p, o) < ROAD_WIDTH[o.kind] / 2 + 4))
          continue;
        if (hasQuay && p.x < waterEdge + 4) continue;
        const k = 0.85 + ((((d * 7 + side * 13) % 10) + 10) % 10) / 25;
        bucket.add("trunk", cyl(0.22, 0.3, 2.4 * k, 6, [p.x, G + 1.2 * k, p.z]));
        bucket.add("tree", cyl(0, 2.6 * k, 5.5 * k, 8, [p.x, G + 2.4 * k + 2.75 * k, p.z]));
        bucket.add("tree", cyl(0, 2.0 * k, 4.2 * k, 8, [p.x, G + 5 * k + 2.1 * k, p.z]));
      }
    // Street lights on the north verge.
    for (let d = 10; d < r.length - 10; d += 42) {
      const p = offset(along(r, d), r.yaw, -(w / 2 + 1.6));
      if (roads.some((o) => o !== r && distToSegment(p, o) < ROAD_WIDTH[o.kind] / 2 + 1)) continue;
      bucket.add("trim", cyl(0.12, 0.16, 10, 6, [p.x, G + 5, p.z]));
      bucket.add("lampHead", box(0.5, 0.18, 1.4, [p.x, G + 10, p.z]));
    }
  }

  return { meshes: bucket.build(), walls, roofs, doorLights, world };
}

function fence(bucket: Bucket, s: SiteView, gaps: { edge: string; at: number }[]) {
  const b = s.bounds;
  const sides: [string, { x: number; z: number }, { x: number; z: number }][] = [
    ["n", b.min, { x: b.max.x, z: b.min.z }],
    ["s", { x: b.min.x, z: b.max.z }, b.max],
    ["w", b.min, { x: b.min.x, z: b.max.z }],
    ["e", { x: b.max.x, z: b.min.z }, b.max],
  ];
  for (const [edge, a, c] of sides) {
    const alongX = a.z === c.z;
    const lo = alongX ? a.x : a.z;
    const hi = alongX ? c.x : c.z;
    const holes = gaps
      .filter((g) => g.edge === edge)
      .map((g) => [g.at - 7, g.at + 7] as const)
      .sort((p, q) => p[0] - q[0]);
    let cursor = lo;
    const runs: [number, number][] = [];
    for (const [h0, h1] of holes) {
      if (h0 > cursor) runs.push([cursor, h0]);
      cursor = Math.max(cursor, h1);
    }
    if (cursor < hi) runs.push([cursor, hi]);
    for (const [r0, r1] of runs) {
      if (r1 - r0 < 1) continue;
      const P = (t: number) => (alongX ? { x: t, z: a.z } : { x: a.x, z: t });
      for (const y of [0.9, 2.1]) bucket.add("fence", strip(P(r0), P(r1), 0.06, G + y, 0.06));
      for (let t = r0; t <= r1 + 0.01; t += 3) {
        const p = P(Math.min(t, r1));
        bucket.add("fence", box(0.08, 2.4, 0.08, [p.x, G + 1.2, p.z]));
      }
    }
  }
}

function stallMarking(bucket: Bucket, st: StandConfig) {
  const f = { x: Math.sin(st.yaw), z: Math.cos(st.yaw) };
  const r = { x: -f.z, z: f.x };
  const at = (l: number, w: number) => ({
    x: st.position.x + f.x * l + r.x * w,
    z: st.position.z + f.z * l + r.z * w,
  });
  const y = G + 0.03;
  const L = HALF + 0.8;
  const W = 1.9;
  if (st.kind === "door") {
    // Yellow guide lines from the dock wall, either side of the trailer.
    for (const side of [-1, 1])
      bucket.add(
        "markingYellow",
        strip(at(-HALF - 0.4, side * W), at(HALF - 2, side * W), 0.14, y),
      );
    return;
  }
  if (st.kind === "service") {
    bucket.add(
      "markingYellow",
      strip(at(-L, -W), at(L, -W), 0.14, y),
      strip(at(-L, W), at(L, W), 0.14, y),
    );
    return;
  }
  bucket.add(
    "marking",
    strip(at(-L, -W), at(L, -W), 0.12, y),
    strip(at(-L, W), at(L, W), 0.12, y),
    strip(at(-L, -W), at(-L, W), 0.12, y),
  );
}

function lampsAround(bucket: Bucket, s: SiteView) {
  const b = s.bounds;
  const pts = [
    { x: b.min.x + 2, z: b.min.z + 2 },
    { x: b.max.x - 2, z: b.min.z + 2 },
    { x: b.min.x + 2, z: b.max.z - 2 },
    { x: b.max.x - 2, z: b.max.z - 2 },
  ];
  for (const p of pts) {
    bucket.add("trim", cyl(0.18, 0.24, 18, 6, [p.x, G + 9, p.z]));
    bucket.add("lampHead", box(1.6, 0.3, 1.6, [p.x, G + 18, p.z]));
  }
}

/** Walls along one side with openings: segments of [centre, length, bottom, top] in local x. */
function wallSegments(
  length: number,
  height: number,
  doors: number[],
  door: { width: number; height: number },
) {
  const segs: [number, number, number, number][] = [];
  let cursor = -length / 2;
  for (const x of [...doors].sort((a, b) => a - b)) {
    const a = x - door.width / 2;
    if (a > cursor) segs.push([(cursor + a) / 2, a - cursor, 0, height]);
    segs.push([x, door.width, door.height, height]);
    cursor = x + door.width / 2;
  }
  if (cursor < length / 2) segs.push([(cursor + length / 2) / 2, length / 2 - cursor, 0, height]);
  return segs;
}

/**
 * One building. Halls (cross-dock, freight station) stand on a dock-height plinth with openings at
 * their real doors (from the site's door stands); the workshop has drive-in doors at its service
 * bays. Returns the roof (separate, so the facility view can hide it).
 */
function building(
  bucket: Bucket,
  site: SiteView,
  b: SiteBuildingConfig,
  doorLights: NetworkStatic["doorLights"],
  cutaway: CutawayWall[],
): BufferGeometry | null {
  const w = b.max.x - b.min.x;
  const d = b.max.z - b.min.z;
  const cx = (b.min.x + b.max.x) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const raised = b.style === "cross_dock" || b.style === "cfs_shed";
  const floor = raised ? 0 : G;
  const top = floor + b.height;

  if (b.style === "office" || b.style === "gatehouse") {
    bucket.add("wall", box(w, b.height, d, [cx, G + b.height / 2, cz]));
    if (b.style === "office")
      for (const y of [1.3, 3.1].filter((y) => y < b.height - 0.6))
        bucket.add("glazing", box(w + 0.06, 0.9, d + 0.06, [cx, G + y, cz]));
    else bucket.add("glazing", box(w + 0.06, 1.1, d + 0.06, [cx, G + 1.6, cz]));
    bucket.add("trim", box(w + 0.8, 0.3, d + 0.8, [cx, G + b.height + 0.15, cz]));
    if (b.style === "gatehouse") {
      // Barrier arm across the lane next to the booth (raised for traffic in this slice).
      bucket.add("hazard", box(0.12, 0.12, 6.5, [b.max.x + 1, G + 1.1, cz - 3.3]));
    }
    return null;
  }

  // Doors on each wall, from the stands that open onto this building.
  const doors: Record<"n" | "s" | "w" | "e", number[]> = { n: [], s: [], w: [], e: [] };
  const service = b.style === "workshop";
  for (const st of site.stands) {
    if (service ? st.kind !== "service" : st.kind !== "door") continue;
    const f = { x: Math.sin(st.yaw), z: Math.cos(st.yaw) };
    // Dock doors: where the trailer's rear meets the wall. Service bays: the wall the truck enters by.
    const p = service
      ? { x: st.position.x + f.x * (HALF + 3), z: st.position.z + f.z * (HALF + 3) }
      : { x: st.position.x - f.x * (HALF + 0.6), z: st.position.z - f.z * (HALF + 0.6) };
    const near = (a: number, v: number) => Math.abs(a - v) < (service ? 6 : 0.5);
    if (p.x >= b.min.x - 0.5 && p.x <= b.max.x + 0.5) {
      if (near(p.z, b.min.z)) doors.n.push(p.x - cx);
      else if (near(p.z, b.max.z)) doors.s.push(p.x - cx);
    }
    if (p.z >= b.min.z - 0.5 && p.z <= b.max.z + 0.5) {
      if (near(p.x, b.min.x)) doors.w.push(p.z - cz);
      else if (near(p.x, b.max.x)) doors.e.push(p.z - cz);
    }
    if (!service)
      doorLights.push({
        stand: st.id,
        site: site.id,
        position: [
          p.x + f.x * 0.25 + Math.cos(st.yaw) * (DOCK_DOOR.width / 2 + 0.35),
          floor + DOCK_DOOR.height + 0.35,
          p.z + f.z * 0.25 - Math.sin(st.yaw) * (DOCK_DOOR.width / 2 + 0.35),
        ],
      });
  }
  const door = service ? SERVICE_DOOR : DOCK_DOOR;
  const walls: { key: "n" | "s" | "w" | "e"; len: number; pos: [number, number]; rot: number }[] = [
    { key: "n", len: w + WALL * 2, pos: [cx, b.min.z - WALL / 2], rot: 0 },
    { key: "s", len: w + WALL * 2, pos: [cx, b.max.z + WALL / 2], rot: 0 },
    { key: "w", len: d, pos: [b.min.x - WALL / 2, cz], rot: Math.PI / 2 },
    { key: "e", len: d, pos: [b.max.x + WALL / 2, cz], rot: Math.PI / 2 },
  ];
  for (const wall of walls) {
    // Local x along the wall: +x for n/s walls; for w/e walls (rotated +90°) local x maps to -z.
    const openings = wall.rot === 0 ? doors[wall.key] : doors[wall.key].map((z) => -z);
    const full: BufferGeometry[] = [];
    const knee: BufferGeometry[] = [];
    for (const [c, len, y0, y1] of wallSegments(wall.len, b.height, openings, door)) {
      const lx = Math.cos(wall.rot) * c;
      const lz = -Math.sin(wall.rot) * c;
      full.push(
        box(
          len,
          y1 - y0,
          WALL,
          [wall.pos[0] + lx, floor + (y0 + y1) / 2, wall.pos[1] + lz],
          [0, wall.rot, 0],
        ),
      );
      if (y0 === 0)
        knee.push(
          box(
            len,
            KNEE,
            WALL,
            [wall.pos[0] + lx, floor + KNEE / 2, wall.pos[1] + lz],
            [0, wall.rot, 0],
          ),
        );
    }
    full.push(
      box(wall.len, 0.35, WALL + 0.1, [wall.pos[0], top + 0.17, wall.pos[1]], [0, wall.rot, 0]),
    );
    const normal: [number, number] =
      wall.key === "n" ? [0, -1] : wall.key === "s" ? [0, 1] : wall.key === "w" ? [-1, 0] : [1, 0];
    cutaway.push({
      site: site.id,
      building: b.id,
      normal,
      center: wall.pos,
      full: merge(full),
      knee: knee.length ? merge(knee) : null,
    });
    // Dock shelters around each opening, outside the wall.
    if (!service)
      for (const o of openings) {
        const n =
          wall.key === "n"
            ? { x: 0, z: -1 }
            : wall.key === "s"
              ? { x: 0, z: 1 }
              : wall.key === "w"
                ? { x: -1, z: 0 }
                : { x: 1, z: 0 };
        const t = { x: Math.cos(wall.rot), z: -Math.sin(wall.rot) };
        const base = {
          x: wall.pos[0] + t.x * o + n.x * 0.45,
          z: wall.pos[1] + t.z * o + n.z * 0.45,
        };
        for (const side of [-1, 1]) {
          const q = {
            x: base.x + t.x * side * (door.width / 2 + 0.2),
            z: base.z + t.z * side * (door.width / 2 + 0.2),
          };
          bucket.add(
            "seal",
            box(0.4, door.height + 0.4, 0.6, [q.x, floor + door.height / 2, q.z], [0, wall.rot, 0]),
          );
        }
        bucket.add(
          "seal",
          box(
            door.width + 0.8,
            0.6,
            0.6,
            [base.x, floor + door.height + 0.3, base.z],
            [0, wall.rot, 0],
          ),
        );
        bucket.add(
          "bumper",
          box(
            0.25,
            0.45,
            0.18,
            [base.x - t.x * 1.1, floor - 0.35, base.z - t.z * 1.1],
            [0, wall.rot, 0],
          ),
        );
        bucket.add(
          "bumper",
          box(
            0.25,
            0.45,
            0.18,
            [base.x + t.x * 1.1, floor - 0.35, base.z + t.z * 1.1],
            [0, wall.rot, 0],
          ),
        );
      }
  }
  if (raised) bucket.add("plinth", box(w + 0.5, -G, d + 0.5, [cx, G / 2, cz]));
  bucket.add(raised ? "hallFloor" : "padDark", box(w, 0.02, d, [cx, floor + 0.01, cz]));
  // Roof: a light steel deck with a skylight band; hidden in this site's facility view.
  return merge([
    box(w + 0.6, 0.3, d + 0.6, [cx, top + 0.2, cz]),
    box(w * 0.7, 0.18, 1.2, [cx, top + 0.42, cz]),
  ]);
}
