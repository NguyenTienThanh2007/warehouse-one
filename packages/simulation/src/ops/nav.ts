import { STAGING_LANE_CAPACITY, type Heading } from "./model";
import type { SimulationConfig } from "../types";

/**
 * Navigation graph derived from facility geometry (Phase 2).
 *
 * One-way circulation (as in many narrow-aisle warehouses): vehicles cannot pass each other in a
 * single-lane aisle, so two-way aisles produce head-on deadlocks. Instead:
 * - The west cross aisle runs north (towards the back wall), the east cross aisle south.
 * - The back aisle runs east, the front aisle (with the dock junctions) runs west, and middle
 *   aisles alternate. Every aisle joins the two cross aisles, so the graph is strongly connected
 *   and every pick face is reachable — sometimes by looping round.
 * - Dock paths (junction → beside each staging position → door) and the charging road (with a spur
 *   to each charger) are two-way dead ends. Each dock path and the road is an exclusive zone, claimed
 *   before entering, so vehicles meet head-on nowhere.
 * With no head-on conflicts, a vehicle only ever waits behind another moving the same way, behind
 * one handling a pallet, or for a dead-end zone whose occupant is free to leave; a wait-for cycle
 * would need a whole loop filled with vehicles.
 *
 * All coordinates are integer millimetres and every edge is axis-aligned, so lengths are exact.
 * Racks are never crossed: aisle lines run between pick faces, cross aisles beyond the row ends.
 */

export type NavNodeKind = "aisle" | "cross" | "junction" | "lane" | "door" | "road" | "charger";

export interface NavNode {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly kind: NavNodeKind;
  /** Exclusive dead-end zone (`dock:<id>` or `road`), or null. */
  readonly zone: string | null;
}

export interface NavEdge {
  readonly to: string;
  readonly length: number;
}

export interface NavGraph {
  readonly nodes: ReadonlyMap<string, NavNode>;
  /** Outgoing edges (one-way where traffic rules say so), sorted by neighbour id. */
  readonly adjacency: ReadonlyMap<string, readonly NavEdge[]>;
  /** Pick/put-away node for each rack location. */
  readonly pickNode: ReadonlyMap<string, string>;
  /** Per dock: path node beside each staging position (index = position). */
  readonly laneNodes: ReadonlyMap<string, readonly string[]>;
  /** Per dock: the node at the door, where trailers are loaded and unloaded. */
  readonly doorNode: ReadonlyMap<string, string>;
  /** Home (charger) node per material-handling vehicle. */
  readonly chargerNode: ReadonlyMap<string, string>;
  /** Staging pallet centres per dock (mm), index = position. */
  readonly stagingSpots: ReadonlyMap<string, readonly { x: number; z: number }[]>;
  /** Structural problems; a graph with problems must not be used for operations. */
  readonly problems: readonly string[];
}

const mm = (m: number) => Math.round(m * 1000);
const CROSS_AISLE_CLEARANCE = 2000;
const STAGING_FIRST_OFFSET = 2000;
const STAGING_PITCH = 1400;
const STAGING_LANE_OFFSET_X = 1600;
const DOOR_OFFSET = 1200;
/** Clearance kept between travel lines and rack footprints (half a vehicle width). */
export const VEHICLE_CLEARANCE = 600;

const cache = new WeakMap<SimulationConfig, NavGraph>();

export function navGraph(config: SimulationConfig): NavGraph {
  let g = cache.get(config);
  if (!g) {
    g = buildNavGraph(config);
    cache.set(config, g);
  }
  return g;
}

export function headingBetween(a: NavNode, b: NavNode): Heading {
  if (b.x > a.x) return "px";
  if (b.x < a.x) return "nx";
  return b.z > a.z ? "pz" : "nz";
}

function buildNavGraph(config: SimulationConfig): NavGraph {
  const problems: string[] = [];
  const nodes = new Map<string, NavNode>();
  const edges = new Map<string, Map<string, number>>();
  const pickNode = new Map<string, string>();
  const laneNodes = new Map<string, string[]>();
  const doorNode = new Map<string, string>();
  const chargerNode = new Map<string, string>();
  const stagingSpots = new Map<string, { x: number; z: number }[]>();
  const empty = (): NavGraph => ({
    nodes,
    adjacency: new Map(),
    pickNode,
    laneNodes,
    doorNode,
    chargerNode,
    stagingSpots,
    problems,
  });

  const f = config.facility;
  if (!f) return { ...empty(), problems: ["no facility data"] };
  if (config.locations.length === 0) return { ...empty(), problems: ["no storage locations"] };

  const addNode = (
    id: string,
    x: number,
    z: number,
    kind: NavNodeKind,
    zone: string | null = null,
  ) => {
    if (!nodes.has(id)) nodes.set(id, { id, x, z, kind, zone });
    return id;
  };
  /** Add an edge a→b, and b→a too unless it is one-way. */
  const link = (a: string, b: string, oneWay = false) => {
    const na = nodes.get(a);
    const nb = nodes.get(b);
    if (!na || !nb || a === b) return;
    if (na.x !== nb.x && na.z !== nb.z) problems.push(`edge ${a}–${b} is not axis-aligned`);
    const len = Math.abs(na.x - nb.x) + Math.abs(na.z - nb.z);
    if (!edges.has(a)) edges.set(a, new Map());
    if (!edges.has(b)) edges.set(b, new Map());
    edges.get(a)?.set(b, len);
    if (!oneWay) edges.get(b)?.set(a, len);
  };

  const rack = f.rack;
  const aisleWidth = mm(f.aisle_width ?? 3.6);
  const depth = mm(rack.depth);
  const bayWidth = mm(rack.bay_width);

  // 1. Aisle centre lines in front of each pick face.
  const lines = new Map<number, Map<number, string[]>>(); // z -> x -> location ids
  for (const loc of config.locations) {
    const yaw = loc.yaw ?? 0;
    const facing = Math.abs(yaw) < 1e-6 ? 1 : Math.abs(Math.abs(yaw) - Math.PI) < 1e-6 ? -1 : 0;
    if (facing === 0) {
      problems.push(`location '${loc.id}' must face +z or -z (yaw 0 or π) for navigation`);
      continue;
    }
    const z = mm(loc.position.z) + facing * (depth / 2 + aisleWidth / 2);
    const x = mm(loc.position.x);
    if (!lines.has(z)) lines.set(z, new Map());
    const row = lines.get(z) as Map<number, string[]>;
    row.set(x, [...(row.get(x) ?? []), loc.id]);
  }
  const xs = config.locations.map((l) => mm(l.position.x));
  const xWest = Math.min(...xs) - bayWidth / 2 - CROSS_AISLE_CLEARANCE;
  const xEast = Math.max(...xs) + bayWidth / 2 + CROSS_AISLE_CLEARANCE;
  const lineZs = [...lines.keys()].sort((a, b) => a - b);
  const frontZ = lineZs.at(-1) as number;
  const lineIndex = new Map(lineZs.map((z, i) => [z, i]));
  const lineNodeId = (z: number, x: number) => `a${lineIndex.get(z)}@${x}`;

  // Dock junctions on the front aisle.
  const docks = [...f.docks].sort((a, b) => a.id.localeCompare(b.id));
  for (const d of docks) {
    if (Math.abs(d.yaw) > 1e-6) problems.push(`dock '${d.id}' must face +z`);
  }

  for (const z of lineZs) {
    const row = lines.get(z) as Map<number, string[]>;
    const stops = new Set<number>([xWest, xEast, ...row.keys()]);
    if (z === frontZ) for (const d of docks) stops.add(mm(d.position.x));
    const sorted = [...stops].sort((a, b) => a - b);
    for (const x of sorted) {
      const kind: NavNodeKind =
        x === xWest || x === xEast ? "cross" : row.has(x) ? "aisle" : "junction";
      addNode(lineNodeId(z, x), x, z, kind);
      for (const locId of row.get(x) ?? []) pickNode.set(locId, lineNodeId(z, x));
    }
    // Back aisle eastbound, front aisle westbound, middle aisles alternate.
    const i = lineIndex.get(z) as number;
    const eastbound = z !== frontZ && i % 2 === 0;
    for (let k = 1; k < sorted.length; k++) {
      const west = lineNodeId(z, sorted[k - 1] as number);
      const east = lineNodeId(z, sorted[k] as number);
      if (eastbound) link(west, east, true);
      else link(east, west, true);
    }
  }
  // 2. Cross aisles: west runs north (to lower z), east runs south.
  for (let i = 1; i < lineZs.length; i++) {
    const back = lineZs[i - 1] as number;
    const front = lineZs[i] as number;
    link(lineNodeId(front, xWest), lineNodeId(back, xWest), true);
    link(lineNodeId(back, xEast), lineNodeId(front, xEast), true);
  }

  // 3. Dock paths: junction → beside each staging position (deepest first) → door.
  const wallZ = mm(f.building.max.z);
  for (const d of docks) {
    const x = mm(d.position.x);
    const lane: string[] = [];
    const spots: { x: number; z: number }[] = [];
    for (let k = 0; k < STAGING_LANE_CAPACITY; k++) {
      const z = wallZ - STAGING_FIRST_OFFSET - k * STAGING_PITCH;
      lane.push(addNode(`${d.id}@lane${k}`, x, z, "lane", `dock:${d.id}`));
      spots.push({ x: x + STAGING_LANE_OFFSET_X, z });
    }
    const door = addNode(`${d.id}@door`, x, wallZ - DOOR_OFFSET, "door", `dock:${d.id}`);
    const chain = [lineNodeId(frontZ, x), ...[...lane].reverse(), door];
    for (let i = 1; i < chain.length; i++) link(chain[i - 1] as string, chain[i] as string);
    if ((nodes.get(lane[lane.length - 1] as string)?.z ?? 0) <= frontZ + VEHICLE_CLEARANCE) {
      problems.push(`dock '${d.id}' staging lane overlaps the front aisle`);
    }
    laneNodes.set(d.id, lane);
    doorNode.set(d.id, door);
    stagingSpots.set(d.id, spots);
  }

  // 4. Charging road and charger spurs.
  const mhe = [...f.equipment]
    .filter((e) => e.kind !== "truck")
    .sort((a, b) => a.id.localeCompare(b.id));
  const roadZs = new Set<number>();
  for (const e of mhe) {
    const x = mm(e.position.x);
    const z = mm(e.position.z);
    if (z <= frontZ + VEHICLE_CLEARANCE)
      problems.push(`charger for '${e.id}' must lie south of the front aisle`);
    if (x >= xWest - VEHICLE_CLEARANCE * 2)
      problems.push(`charger for '${e.id}' must lie west of the west cross aisle`);
    roadZs.add(z);
    chargerNode.set(e.id, addNode(`chg@${e.id}`, x, z, "charger"));
  }
  const road = [
    lineNodeId(frontZ, xWest),
    ...[...roadZs].sort((a, b) => a - b).map((z) => addNode(`road@${z}`, xWest, z, "road", "road")),
  ];
  for (let i = 1; i < road.length; i++) link(road[i - 1] as string, road[i] as string);
  for (const e of mhe) link(chargerNode.get(e.id) as string, `road@${mm(e.position.z)}`);

  // 5. Validation: inside the building, clear of racks, strongly connected.
  const b = f.building;
  for (const n of nodes.values()) {
    if (
      n.x < mm(b.min.x) + VEHICLE_CLEARANCE ||
      n.x > mm(b.max.x) - VEHICLE_CLEARANCE ||
      n.z < mm(b.min.z) + VEHICLE_CLEARANCE ||
      n.z > mm(b.max.z) - VEHICLE_CLEARANCE
    ) {
      problems.push(`node '${n.id}' is outside the building clearance`);
    }
  }
  const racks = config.locations.map((l) => ({
    id: l.id,
    x0: mm(l.position.x) - bayWidth / 2,
    x1: mm(l.position.x) + bayWidth / 2,
    z0: mm(l.position.z) - depth / 2,
    z1: mm(l.position.z) + depth / 2,
  }));
  for (const [a, nbrs] of edges) {
    for (const bId of nbrs.keys()) {
      const na = nodes.get(a) as NavNode;
      const nb = nodes.get(bId) as NavNode;
      const sx0 = Math.min(na.x, nb.x) - VEHICLE_CLEARANCE;
      const sx1 = Math.max(na.x, nb.x) + VEHICLE_CLEARANCE;
      const sz0 = Math.min(na.z, nb.z) - VEHICLE_CLEARANCE;
      const sz1 = Math.max(na.z, nb.z) + VEHICLE_CLEARANCE;
      for (const r of racks) {
        if (sx0 < r.x1 && sx1 > r.x0 && sz0 < r.z1 && sz1 > r.z0) {
          problems.push(`edge ${a}–${bId} passes within ${VEHICLE_CLEARANCE} mm of rack '${r.id}'`);
          break;
        }
      }
    }
  }
  const first = nodes.keys().next().value as string | undefined;
  if (first) {
    const reverse = new Map<string, string[]>();
    for (const [a, nbrs] of edges)
      for (const b of nbrs.keys()) reverse.set(b, [...(reverse.get(b) ?? []), a]);
    const reach = (next: (n: string) => Iterable<string>) => {
      const seen = new Set([first]);
      const queue = [first];
      while (queue.length) {
        const n = queue.pop() as string;
        for (const m of next(n)) {
          if (seen.has(m)) continue;
          seen.add(m);
          queue.push(m);
        }
      }
      return seen.size;
    };
    const forward = reach((n) => edges.get(n)?.keys() ?? []);
    const backward = reach((n) => reverse.get(n) ?? []);
    if (forward !== nodes.size || backward !== nodes.size) {
      problems.push(
        `navigation graph is not strongly connected (${nodes.size - Math.min(forward, backward)} nodes cut off)`,
      );
    }
  }

  const adjacency = new Map<string, NavEdge[]>();
  for (const id of [...nodes.keys()].sort()) {
    adjacency.set(
      id,
      [...(edges.get(id) ?? new Map<string, number>()).entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([to, length]) => ({ to, length })),
    );
  }
  return { nodes, adjacency, pickNode, laneNodes, doorNode, chargerNode, stagingSpots, problems };
}

export interface ShortestPaths {
  readonly distance: ReadonlyMap<string, number>;
  readonly previous: ReadonlyMap<string, string>;
}

/**
 * Dijkstra from `source`. Ties are broken by node id, so equal-length alternatives always resolve
 * the same way. `avoid` removes nodes (used to route around a blocking vehicle).
 */
export function shortestPaths(
  g: NavGraph,
  source: string,
  avoid: ReadonlySet<string> = new Set(),
): ShortestPaths {
  const distance = new Map<string, number>([[source, 0]]);
  const previous = new Map<string, string>();
  const done = new Set<string>();
  const frontier = new Set<string>([source]);
  while (frontier.size > 0) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of frontier) {
      const d = distance.get(n) as number;
      if (d < bestD || (d === bestD && best !== null && n < best)) {
        best = n;
        bestD = d;
      }
    }
    const u = best as string;
    frontier.delete(u);
    done.add(u);
    for (const e of g.adjacency.get(u) ?? []) {
      if (done.has(e.to) || avoid.has(e.to)) continue;
      const nd = bestD + e.length;
      const cur = distance.get(e.to);
      if (cur === undefined || nd < cur || (nd === cur && u < (previous.get(e.to) as string))) {
        distance.set(e.to, nd);
        previous.set(e.to, u);
        frontier.add(e.to);
      }
    }
  }
  return { distance, previous };
}

/** Node sequence from `source` to `target`, excluding `source`; null if unreachable. */
export function findPath(
  g: NavGraph,
  source: string,
  target: string,
  avoid?: ReadonlySet<string>,
): string[] | null {
  if (source === target) return [];
  const { previous } = shortestPaths(g, source, avoid);
  if (!previous.has(target)) return null;
  const path: string[] = [];
  for (let n: string | undefined = target; n !== undefined && n !== source; n = previous.get(n))
    path.push(n);
  return path.reverse();
}

export function pathLength(g: NavGraph, source: string, path: readonly string[]): number {
  let total = 0;
  let prev = source;
  for (const n of path) {
    total += g.adjacency.get(prev)?.find((e) => e.to === n)?.length ?? 0;
    prev = n;
  }
  return total;
}
