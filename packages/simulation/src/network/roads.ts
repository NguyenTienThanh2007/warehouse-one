import type { SimulationConfig } from "../types";
import type { NetworkConfig, RoadConfig } from "./model";

/**
 * Road graph of the logistics network. Edge lengths are integer millimetres so routing and
 * movement are exact; shortest paths break ties by node id, so they never depend on map order.
 */
export interface RoadGraph {
  readonly nodes: ReadonlyMap<string, { readonly x: number; readonly z: number }>;
  /** node -> neighbours, sorted by id. */
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  /** Undirected edge key ("a|b" with a < b) -> road. */
  readonly roads: ReadonlyMap<string, RoadConfig>;
  readonly lengths: ReadonlyMap<string, number>;
  /** Shortest route (excluding `from`, including `to`), or null when unreachable. */
  route(from: string, to: string): readonly string[] | null;
  /** Length of the shortest route in mm, or null when unreachable. */
  distance(from: string, to: string): number | null;
}

export const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const cache = new WeakMap<NetworkConfig, RoadGraph>();

export function roadGraph(config: SimulationConfig): RoadGraph {
  const net = config.network;
  if (!net) throw new Error("invariant violated: road graph of a config without a network");
  let g = cache.get(net);
  if (!g) {
    g = build(net);
    cache.set(net, g);
  }
  return g;
}

function build(net: NetworkConfig): RoadGraph {
  const nodes = new Map(net.nodes.map((n) => [n.id, n.position]));
  const adjacency = new Map<string, string[]>(net.nodes.map((n) => [n.id, []]));
  const roads = new Map<string, RoadConfig>();
  const lengths = new Map<string, number>();
  for (const r of net.roads) {
    const a = nodes.get(r.from);
    const b = nodes.get(r.to);
    if (!a || !b) continue; // reported by validation
    const key = edgeKey(r.from, r.to);
    roads.set(key, r);
    // Integer millimetre deltas and sqrt (correctly rounded), not Math.hypot (implementation-defined).
    const dx = Math.round(b.x * 1000) - Math.round(a.x * 1000);
    const dz = Math.round(b.z * 1000) - Math.round(a.z * 1000);
    lengths.set(key, Math.max(1, Math.round(Math.sqrt(dx * dx + dz * dz))));
    adjacency.get(r.from)?.push(r.to);
    adjacency.get(r.to)?.push(r.from);
  }
  for (const list of adjacency.values()) list.sort();

  // Single-source Dijkstra per origin, memoised. Graphs are small (tens of nodes).
  const trees = new Map<string, { dist: Map<string, number>; prev: Map<string, string> }>();
  const tree = (from: string) => {
    let t = trees.get(from);
    if (t) return t;
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const done = new Set<string>();
    for (;;) {
      let best: string | null = null;
      for (const [n, d] of dist) {
        if (done.has(n)) continue;
        if (best === null) {
          best = n;
          continue;
        }
        const bd = dist.get(best) as number;
        if (d < bd || (d === bd && n < best)) best = n;
      }
      if (best === null) break;
      done.add(best);
      const base = dist.get(best) as number;
      for (const next of adjacency.get(best) ?? []) {
        if (done.has(next)) continue;
        const d = base + (lengths.get(edgeKey(best, next)) as number);
        const old = dist.get(next);
        if (old === undefined || d < old || (d === old && best < (prev.get(next) as string))) {
          dist.set(next, d);
          prev.set(next, best);
        }
      }
    }
    t = { dist, prev };
    trees.set(from, t);
    return t;
  };

  return {
    nodes,
    adjacency,
    roads,
    lengths,
    route(from, to) {
      if (from === to) return [];
      const { dist, prev } = tree(from);
      if (!dist.has(to)) return null;
      const out: string[] = [];
      for (let n: string | undefined = to; n !== undefined && n !== from; n = prev.get(n))
        out.push(n);
      return out.reverse();
    },
    distance(from, to) {
      return tree(from).dist.get(to) ?? null;
    },
  };
}

/** Length of one edge in mm (0 when the nodes are not adjacent). */
export function edgeLength(g: RoadGraph, a: string, b: string): number {
  return g.lengths.get(edgeKey(a, b)) ?? 0;
}
