/**
 * Pure mapping from the logistics network (config + `state.network`, Phase 5) to what the world
 * renderer draws and the panels show. Poses come from the simulation's `linehaulPose`; the only
 * thing added here is interpolation between the last two ticks and the layout of things the
 * simulation counts but does not place (pallets on a site floor, containers in a stack).
 */
import {
  cargoTotal,
  linehaulPose,
  TRUCK_LENGTH,
  type ContainerYardConfig,
  type LinehaulState,
  type NetworkState,
  type Pose,
  type SimulationConfig,
  type SimulationState,
  type SiteBuildingConfig,
  type SiteConfig,
  type SiteKind,
  type StandConfig,
  type TransferState,
} from "@warehouse-one/simulation";
import { archetypeForSku, resolveFacility, type Bounds, type CargoArchetype } from "./derive";
import { lerpPose } from "./ops-view";

/** A site as the world view draws it; single-site scenarios get one default site (the DC). */
export interface SiteView {
  readonly id: string;
  readonly kind: SiteKind;
  readonly name: string;
  readonly bounds: Bounds;
  readonly primary: boolean;
  readonly stands: readonly StandConfig[];
  readonly buildings: readonly SiteBuildingConfig[];
  readonly containers?: ContainerYardConfig;
  readonly palletCapacity: number;
}

/** Id of the implicit site of a single-site scenario (backward compatible with Phases 0–4). */
export const DEFAULT_SITE_ID = "main-site";

export const SITE_KIND_LABEL: Record<SiteKind, string> = {
  distribution_center: "Distribution centre",
  cross_dock: "Cross-dock",
  container_terminal: "Container terminal",
  fleet_depot: "Fleet depot",
  gateway: "Highway gateway",
};

export function resolveSites(config: SimulationConfig): SiteView[] {
  const net = config.network;
  if (!net) {
    const f = resolveFacility(config);
    return [
      {
        id: DEFAULT_SITE_ID,
        kind: "distribution_center",
        name: f.name,
        bounds: f.site,
        primary: true,
        stands: [],
        buildings: [],
        palletCapacity: 0,
      },
    ];
  }
  return net.sites.map((s: SiteConfig) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    bounds: s.bounds,
    primary: s.id === net.primary_site,
    stands: s.stands,
    buildings: s.buildings,
    ...(s.containers ? { containers: s.containers } : {}),
    palletCapacity: s.pallet_capacity,
  }));
}

export function primarySiteId(config: SimulationConfig): string {
  return config.network?.primary_site ?? DEFAULT_SITE_ID;
}

/** Everything the world contains (sites and roads), in metres. */
export function worldBounds(config: SimulationConfig): Bounds {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const s of resolveSites(config)) {
    xs.push(s.bounds.min.x, s.bounds.max.x);
    zs.push(s.bounds.min.z, s.bounds.max.z);
  }
  for (const n of config.network?.nodes ?? []) {
    xs.push(n.position.x);
    zs.push(n.position.z);
  }
  return {
    min: { x: Math.min(...xs), z: Math.min(...zs) },
    max: { x: Math.max(...xs), z: Math.max(...zs) },
  };
}

// Roads -----------------------------------------------------------------------------------------

export interface RoadSegment {
  readonly id: string;
  readonly kind: "arterial" | "service";
  readonly a: { x: number; z: number };
  readonly b: { x: number; z: number };
  readonly length: number;
  /** Heading from a to b (LocationConfig.yaw convention). */
  readonly yaw: number;
}

/** Carriageway width: two 3.5 m lanes plus shoulders (arterial) or a 7 m site lane. */
export const ROAD_WIDTH = { arterial: 10, service: 7.5 } as const;

export function roadSegments(config: SimulationConfig): RoadSegment[] {
  const net = config.network;
  if (!net) return [];
  const nodes = new Map(net.nodes.map((n) => [n.id, n.position]));
  return net.roads.flatMap((r) => {
    const a = nodes.get(r.from);
    const b = nodes.get(r.to);
    if (!a || !b) return [];
    return [
      {
        id: r.id,
        kind: r.kind,
        a,
        b,
        length: Math.hypot(b.x - a.x, b.z - a.z),
        yaw: Math.atan2(b.x - a.x, b.z - a.z),
      },
    ];
  });
}

/** Road junctions (nodes with three or more roads, or a bend), where markings stop. */
export function junctions(
  config: SimulationConfig,
): { x: number; z: number; kind: RoadSegment["kind"] }[] {
  const net = config.network;
  if (!net) return [];
  const degree = new Map<string, { n: number; arterial: boolean }>();
  for (const r of net.roads)
    for (const id of [r.from, r.to]) {
      const d = degree.get(id) ?? { n: 0, arterial: false };
      degree.set(id, { n: d.n + 1, arterial: d.arterial || r.kind === "arterial" });
    }
  return net.nodes.flatMap((n) => {
    const d = degree.get(n.id);
    return d && d.n !== 2
      ? [{ ...n.position, kind: d.arterial ? ("arterial" as const) : ("service" as const) }]
      : [];
  });
}

// Line-haul trucks ------------------------------------------------------------------------------

export interface LinehaulView {
  readonly id: string;
  readonly label: string;
  readonly status: LinehaulState["status"];
  readonly pose: Pose;
  readonly pallets: number;
  readonly transferId: string | null;
}

/** Trucks the network draws now (trucks inside the DC simulation or off the map are not). */
export function linehaulViews(
  config: SimulationConfig,
  prev: SimulationState | undefined,
  curr: SimulationState,
  alpha: number,
): LinehaulView[] {
  const net = curr.network;
  if (!net || !config.network) return [];
  const labels = new Map(config.network.vehicles.map((v) => [v.id, v.label]));
  const out: LinehaulView[] = [];
  for (const id of Object.keys(net.vehicles).sort()) {
    const v = net.vehicles[id] as LinehaulState;
    const now = linehaulPose(config, curr, v);
    if (!now) continue;
    const before = prev?.network?.vehicles[id];
    const then = before && prev ? linehaulPose(config, prev, before) : null;
    out.push({
      id,
      label: labels.get(id) ?? id,
      status: v.status,
      pose: then ? lerpPose(then, now, alpha) : now,
      pallets: cargoTotal(v.cargo),
      transferId: v.transfer_id,
    });
  }
  return out;
}

// Site activity ---------------------------------------------------------------------------------

export interface SiteActivity {
  readonly pallets: number;
  readonly bySku: Readonly<Record<string, number>>;
  readonly containers: number;
  readonly doorsBusy: number;
  readonly doors: number;
  readonly stallsBusy: number;
  readonly stalls: number;
  readonly trucksHere: readonly string[];
  readonly inbound: readonly TransferState[];
  readonly outbound: readonly TransferState[];
  readonly received: number;
  readonly dispatched: number;
}

export function siteActivity(
  config: SimulationConfig,
  state: SimulationState,
  siteId: string,
): SiteActivity | null {
  const net = state.network;
  const site = config.network?.sites.find((s) => s.id === siteId);
  const s = net?.sites[siteId];
  if (!net || !site || !s) return null;
  const doors = site.stands.filter((x) => x.kind === "door");
  const stalls = site.stands.filter((x) => x.kind !== "door");
  const held = (ids: readonly StandConfig[]) =>
    ids.filter((x) => {
      const v = s.stands[x.id];
      return v && net.vehicles[v]?.stand_id === x.id;
    }).length;
  const transfers = Object.values(net.transfers);
  return {
    pallets: Object.values(s.stock).reduce((a, b) => a + b, 0),
    bySku: s.stock,
    containers: s.containers,
    doors: doors.length,
    doorsBusy: held(doors),
    stalls: stalls.length,
    stallsBusy: held(stalls),
    trucksHere: Object.values(net.vehicles)
      .filter((v) => v.site_id === siteId)
      .map((v) => v.id)
      .sort(),
    inbound: transfers.filter((t) => t.to_site === siteId),
    outbound: transfers.filter((t) => t.from_site === siteId),
    received: s.received,
    dispatched: s.dispatched,
  };
}

/** Totals for the network KPI chips. */
export function networkSummary(state: SimulationState) {
  const net: NetworkState | undefined = state.network;
  if (!net) return null;
  const vehicles = Object.values(net.vehicles);
  const moving = vehicles.filter((v) => ["driving", "docking", "undocking"].includes(v.status));
  const transfers = Object.values(net.transfers);
  return {
    trucks: vehicles.length,
    moving: moving.length,
    activeTransfers: transfers.length,
    inTransitPallets: vehicles.reduce((n, v) => n + cargoTotal(v.cargo), 0),
  };
}

// Containers ------------------------------------------------------------------------------------

/** ISO 40 ft high-cube container (m). */
export const CONTAINER = { length: 12.19, height: 2.59, width: 2.44 } as const;
const BAY_PITCH = CONTAINER.length + 0.4;
const ROW_PITCH = CONTAINER.width + 0.35;

/**
 * Every container position of the yard in fill order: lowest tier first across all blocks, so a
 * yard of `n` containers stacks evenly. The first `state.containers` positions are drawn.
 */
export function containerSlots(
  c: ContainerYardConfig,
): { x: number; y: number; z: number; key: string }[] {
  const out: { x: number; y: number; z: number; key: string; tier: number; order: number }[] = [];
  let order = 0;
  for (const b of c.blocks)
    for (let t = 0; t < b.tiers; t++)
      for (let bay = 0; bay < b.bays; bay++)
        for (let row = 0; row < b.rows; row++)
          out.push({
            x: b.origin.x + bay * BAY_PITCH + CONTAINER.length / 2,
            y: t * CONTAINER.height,
            z: b.origin.z + row * ROW_PITCH + CONTAINER.width / 2,
            key: `${b.id}-${bay}-${row}-${t}`,
            tier: t,
            order: order++,
          });
  // Stable: tier, then interleave blocks/bays by a hash-free deterministic order.
  return out
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .map(({ x, y, z, key }) => ({ x, y, z, key }));
}

export function blockBounds(b: ContainerYardConfig["blocks"][number]): Bounds {
  return {
    min: b.origin,
    max: { x: b.origin.x + b.bays * BAY_PITCH - 0.4, z: b.origin.z + b.rows * ROW_PITCH - 0.35 },
  };
}

// Pallets on a site floor -----------------------------------------------------------------------

export interface FloorPallet {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly archetype: CargoArchetype;
  readonly key: string;
}

const LEVELS = 2;
const PALLET_PITCH = 1.35;
const LOAD_HEIGHT = 1.35;

/**
 * Floor positions for a site's pallets: a staging lane two pallets wide behind every door, going
 * into the building, two high. Nearest-the-door positions fill first (round-robin over doors).
 */
export function floorSlots(site: SiteView): { x: number; z: number; yaw: number; level: number }[] {
  const doors = site.stands.filter((s) => s.kind === "door");
  // Lanes run from the door wall into the hall: halfway when the opposite wall has doors too.
  const hall = site.buildings.find((b) => b.style === "cross_dock" || b.style === "cfs_shed");
  const alongZ = doors.every((d) => Math.abs(Math.cos(d.yaw)) > 0.5);
  const span = hall ? (alongZ ? hall.max.z - hall.min.z : hall.max.x - hall.min.x) : 12;
  const twoSided = new Set(doors.map((d) => Math.round(Math.cos(d.yaw)))).size > 1;
  const LANE_DEPTH = Math.max(1, Math.floor((span / (twoSided ? 2 : 1) - 3.6) / PALLET_PITCH));
  const slots: { x: number; z: number; yaw: number; level: number; d: number; i: number }[] = [];
  doors.forEach((door, i) => {
    const fx = Math.sin(door.yaw);
    const fz = Math.cos(door.yaw);
    // Door opening: the truck's rear (half a truck plus the dock gap behind its centre).
    const wallX = door.position.x - fx * (TRUCK_LENGTH / 2 + 0.6);
    const wallZ = door.position.z - fz * (TRUCK_LENGTH / 2 + 0.6);
    for (let level = 0; level < LEVELS; level++)
      for (let d = 0; d < LANE_DEPTH; d++)
        for (const side of [-0.66, 0.66]) {
          const depth = 2.6 + d * PALLET_PITCH;
          slots.push({
            x: wallX - fx * depth + fz * side,
            z: wallZ - fz * depth - fx * side,
            yaw: door.yaw,
            level,
            d: level * LANE_DEPTH + d,
            i,
          });
        }
  });
  return slots
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(({ x, z, yaw, level }) => ({ x, z, yaw, level }));
}

/** The site's stock laid out on its floor (SKUs in id order, so equal stock looks the same). */
export function floorPallets(
  config: SimulationConfig,
  site: SiteView,
  stock: Readonly<Record<string, number>>,
): FloorPallet[] {
  const slots = floorSlots(site);
  const out: FloorPallet[] = [];
  let i = 0;
  for (const sku of Object.keys(stock).sort()) {
    const archetype = archetypeForSku(config, sku);
    for (let n = 0; n < (stock[sku] ?? 0); n++) {
      const s = slots[i];
      if (!s) return out;
      out.push({
        x: s.x,
        y: s.level * LOAD_HEIGHT,
        z: s.z,
        yaw: s.yaw,
        archetype,
        key: `${sku}-${n}`,
      });
      i++;
    }
  }
  return out;
}

/** What the network layer drew, for tests (compared with authoritative state). */
export interface NetworkSceneCounts {
  sites: number;
  buildings: number;
  roads: number;
  linehaulDrawn: number;
  containers: Record<string, number>;
  floorPallets: Record<string, number>;
}
