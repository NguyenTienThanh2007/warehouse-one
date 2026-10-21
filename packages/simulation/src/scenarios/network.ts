import type { CargoLine } from "@warehouse-one/contracts";
import type {
  LaneConfig,
  LinehaulVehicleConfig,
  NetworkConfig,
  RoadConfig,
  RoadNodeConfig,
  SiteConfig,
  StandConfig,
} from "../network/model";
import { TRUCK_LENGTH } from "../ops/pose";
import type { FacilityConfig, Point2 } from "../types";

/**
 * The Northgate logistics park (Phase 5 vertical slice): the existing distribution centre plus a
 * container terminal, a cross-dock, a fleet depot and a highway gateway, joined by an arterial
 * avenue south of the DC and a link road north of it.
 *
 * Coordinates are metres in the DC's frame (x east, z south; the DC building is centred on the
 * origin and its dock wall faces +z). The DC's departing trucks leave its yard straight towards +z
 * and end on the avenue (z = site.max.z + truck length), which is why the avenue runs there.
 */

const HALF = TRUCK_LENGTH / 2;
/** Gap between a stand's truck and the lane it is entered from. */
const SETBACK = 4;

const pt = (x: number, z: number): Point2 => ({ x, z });

class LayoutBuilder {
  readonly nodes: RoadNodeConfig[] = [];
  readonly roads: RoadConfig[] = [];
  private readonly seen = new Set<string>();

  node(id: string, x: number, z: number): string {
    if (!this.seen.has(id)) {
      this.seen.add(id);
      this.nodes.push({ id, position: pt(x, z) });
    }
    return id;
  }

  /** Connect consecutive nodes with roads of one kind. */
  path(kind: RoadConfig["kind"], ...ids: string[]): void {
    for (let i = 1; i < ids.length; i++) {
      const from = ids[i - 1] as string;
      const to = ids[i] as string;
      this.roads.push({ id: `rd-${from}-${to}`, from, to, kind });
    }
  }
}

/** A row of stands perpendicular to a lane running along x (stands on the `side` of the lane). */
function standsAlongX(
  b: LayoutBuilder,
  prefix: string,
  kind: StandConfig["kind"],
  laneZ: number,
  side: 1 | -1,
  xs: readonly number[],
  depth: number,
  role?: StandConfig["role"],
): StandConfig[] {
  return xs.map((x, i) => ({
    id: `${prefix}-${String(i + 1).padStart(2, "0")}`,
    kind,
    approach_node: b.node(`${prefix}-a${String(i + 1).padStart(2, "0")}`, x, laneZ),
    position: pt(x, laneZ + side * depth),
    // Front towards the lane: trucks reverse in and drive out forwards.
    yaw: side === 1 ? Math.PI : 0,
    ...(role ? { role } : {}),
  }));
}

/** A row of stands perpendicular to a lane running along z (stands on the `side` of the lane). */
function standsAlongZ(
  b: LayoutBuilder,
  prefix: string,
  kind: StandConfig["kind"],
  laneX: number,
  side: 1 | -1,
  zs: readonly number[],
): StandConfig[] {
  return zs.map((z, i) => ({
    id: `${prefix}-${String(i + 1).padStart(2, "0")}`,
    kind,
    approach_node: b.node(`${prefix}-a${String(i + 1).padStart(2, "0")}`, laneX, z),
    position: pt(laneX + side * (SETBACK + HALF), z),
    yaw: side === 1 ? -Math.PI / 2 : Math.PI / 2,
  }));
}

const sortX = (b: LayoutBuilder, ids: string[]) =>
  ids.sort(
    (p, q) =>
      (b.nodes.find((n) => n.id === p)?.position.x ?? 0) -
      (b.nodes.find((n) => n.id === q)?.position.x ?? 0),
  );
const sortZ = (b: LayoutBuilder, ids: string[]) =>
  ids.sort(
    (p, q) =>
      (b.nodes.find((n) => n.id === p)?.position.z ?? 0) -
      (b.nodes.find((n) => n.id === q)?.position.z ?? 0),
  );

export interface LogisticsParkOptions {
  readonly dcSiteId: string;
  readonly dcName: string;
  readonly openingStock: { readonly terminal: CargoLine[]; readonly crossDock: CargoLine[] };
  readonly lanes: readonly LaneConfig[];
  readonly fleet: number;
}

export const PARK_SITES = {
  dc: "northgate-dc",
  terminal: "harbour-terminal",
  crossDock: "riverside-xd",
  depot: "fleet-depot",
  gateway: "east-gateway",
} as const;

/** Build the road network, sites, stands and fleet around a facility built by `buildWarehouse`. */
export function buildLogisticsPark(f: FacilityConfig, o: LogisticsParkOptions): NetworkConfig {
  const b = new LayoutBuilder();
  const avenueZ = f.site.max.z + TRUCK_LENGTH;
  const dcGateX =
    (Math.min(...f.docks.map((d) => d.position.x)) +
      Math.max(...f.docks.map((d) => d.position.x))) /
    2;

  // --- Distribution centre: gate on the avenue, truck marshalling yard to the east -------------
  const dcGate = b.node("dc-gate", dcGateX, avenueZ);
  const myX = f.site.max.x + 6;
  const myJ = b.node("dc-my-j", myX, avenueZ);
  const myStands = standsAlongZ(
    b,
    "dc-my",
    "staging",
    myX,
    1,
    [56, 50, 44, 38, 32, 26].map((z) => z + f.site.max.z - 58.65),
  );
  b.path(
    "service",
    myJ,
    ...sortZ(
      b,
      myStands.map((s) => s.approach_node),
    ).reverse(),
  );

  // --- Container terminal (west): container stacks, CFS shed with loading doors ---------------
  const termLaneZ = 8;
  const termGate = b.node("term-gate", -130, avenueZ);
  const termJ = b.node("term-j", -130, termLaneZ);
  const termW = b.node("term-lw", -192, termLaneZ);
  const termE = b.node("term-le", -116, termLaneZ);
  const cfsMaxZ = -20;
  const termDoors = standsAlongX(
    b,
    "term-door",
    "door",
    termLaneZ,
    -1,
    [-180, -168, -156, -144],
    termLaneZ - (cfsMaxZ + 0.6 + HALF),
  );
  // Staging stalls across the lane from the doors share their approach nodes.
  const termStalls = termDoors.map((d, i) => ({
    id: `term-stall-${String(i + 1).padStart(2, "0")}`,
    kind: "staging" as const,
    approach_node: d.approach_node,
    position: pt(d.position.x, termLaneZ + SETBACK + HALF),
    yaw: Math.PI,
  }));
  b.path("service", ...sortX(b, [termW, termJ, termE, ...termDoors.map((d) => d.approach_node)]));
  b.path("service", termGate, termJ);

  // --- Cross-dock (east): doors on both long sides, inbound south, dispatch north --------------
  const xd = { min: pt(95, 2), max: pt(165, 26) };
  const xdSouthZ = 52;
  const xdNorthZ = -24;
  const doorXs = [105, 115, 125, 135, 145, 155];
  const xdGate = b.node("xd-gate", 130, avenueZ);
  const xdS = b.node("xd-s130", 130, xdSouthZ);
  const xdSW = b.node("xd-sw", 70, xdSouthZ);
  const xdSE = b.node("xd-se", 190, xdSouthZ);
  const xdNW = b.node("xd-nw", 70, xdNorthZ);
  const xdNE = b.node("xd-ne", 190, xdNorthZ);
  const south = standsAlongX(
    b,
    "xd-in",
    "door",
    xdSouthZ,
    -1,
    doorXs,
    xdSouthZ - xd.max.z - 0.6 - HALF,
    "inbound",
  );
  // North doors: the truck stands north of the wall, front pointing away from it (-z).
  const north = standsAlongX(
    b,
    "xd-out",
    "door",
    xdNorthZ,
    1,
    doorXs,
    xd.min.z - 0.6 - HALF - xdNorthZ,
    "outbound",
  );
  const xdStalls = standsAlongZ(b, "xd-stall", "staging", 70, 1, [8, 14, 20, 26]);
  b.path("service", ...sortX(b, [xdSW, xdS, xdSE, ...south.map((s) => s.approach_node)]));
  b.path("service", ...sortX(b, [xdNW, xdNE, ...north.map((s) => s.approach_node)]));
  b.path("service", ...sortZ(b, [xdNW, xdSW, ...xdStalls.map((s) => s.approach_node)]));
  b.path("service", xdNE, xdSE);
  b.path("service", xdGate, xdS);

  // --- Fleet depot (south of the avenue): home stalls, maintenance shed -----------------------
  const depotLaneZ = avenueZ + 25;
  const depotGate = b.node("depot-gate", -20, avenueZ);
  const depotJ = b.node("depot-j", -20, depotLaneZ);
  const parkXs = Array.from({ length: o.fleet }, (_, i) => -70 + i * 6);
  const parking = standsAlongX(b, "depot-park", "parking", depotLaneZ, 1, parkXs, SETBACK + HALF);
  // Service bays are inside the workshop (its door wall is 15 m from the lane).
  const service = standsAlongX(b, "depot-svc", "service", depotLaneZ, 1, [8, 20], 15 + 1 + HALF);
  b.path(
    "service",
    ...sortX(b, [
      depotJ,
      b.node("depot-lw", -80, depotLaneZ),
      b.node("depot-le", 30, depotLaneZ),
      ...parking.map((s) => s.approach_node),
      ...service.map((s) => s.approach_node),
    ]),
  );
  b.path("service", depotGate, depotJ);

  // --- Arterial roads ---------------------------------------------------------------------------
  const gw = b.node("gw-exit", 262, avenueZ);
  b.path(
    "arterial",
    ...sortX(b, [b.node("av-w", -300, avenueZ), termGate, depotGate, dcGate, myJ, xdGate, gw]),
  );
  // North link road between the terminal and the cross-dock's dispatch side, behind the DC.
  const northZ = f.site.min.z - 18;
  b.path("arterial", termE, b.node("nl-w", -100, northZ), b.node("nl-e", 60, northZ), xdNW);

  const sites: SiteConfig[] = [
    {
      id: o.dcSiteId,
      kind: "distribution_center",
      name: o.dcName,
      bounds: { min: f.site.min, max: pt(myX + SETBACK + TRUCK_LENGTH + 2, f.site.max.z) },
      gate_node: dcGate,
      stands: myStands,
      buildings: [],
      pallet_capacity: 0,
      handling_ticks_per_pallet: 1,
    },
    {
      id: PARK_SITES.terminal,
      kind: "container_terminal",
      name: "Harbour container terminal",
      bounds: { min: pt(-300, -70), max: pt(-110, 62) },
      gate_node: termGate,
      stands: [...termDoors, ...termStalls],
      buildings: [
        {
          id: "term-cfs",
          label: "Container freight station",
          style: "cfs_shed",
          min: pt(-192, -52),
          max: pt(-132, cfsMaxZ),
          height: 11,
        },
        {
          id: "term-gatehouse",
          label: "Terminal gatehouse",
          style: "gatehouse",
          min: pt(-124, 46),
          max: pt(-118, 52),
          height: 3.2,
        },
      ],
      pallet_capacity: 160,
      opening_stock: o.openingStock.terminal,
      handling_ticks_per_pallet: 25,
      containers: {
        capacity: 360,
        opening: 150,
        pallets_per_container: 12,
        devan_ticks: 300,
        devan_below: 60,
        vessel: { interval_ticks: 9000, phase_ticks: 4500, min: 18, max: 30 },
        blocks: [
          { id: "blk-a", origin: pt(-292, -60), bays: 5, rows: 8, tiers: 3 },
          { id: "blk-b", origin: pt(-292, -30), bays: 5, rows: 8, tiers: 3 },
          { id: "blk-c", origin: pt(-292, 0), bays: 5, rows: 8, tiers: 3 },
          { id: "blk-d", origin: pt(-222, -60), bays: 2, rows: 8, tiers: 3 },
          { id: "blk-e", origin: pt(-222, -30), bays: 2, rows: 8, tiers: 3 },
        ],
      },
    },
    {
      id: PARK_SITES.crossDock,
      kind: "cross_dock",
      name: "Riverside cross-dock",
      bounds: { min: pt(62, -32), max: pt(198, 62) },
      gate_node: xdGate,
      stands: [...south, ...north, ...xdStalls],
      buildings: [
        {
          id: "xd-building",
          label: "Cross-dock hall",
          style: "cross_dock",
          min: xd.min,
          max: xd.max,
          height: 9,
        },
        {
          id: "xd-office",
          label: "Dispatch office",
          style: "office",
          min: pt(170, 6),
          max: pt(184, 20),
          height: 4.5,
        },
      ],
      pallet_capacity: 200,
      opening_stock: o.openingStock.crossDock,
      handling_ticks_per_pallet: 20,
    },
    {
      id: PARK_SITES.depot,
      kind: "fleet_depot",
      name: "Fleet depot & workshop",
      bounds: { min: pt(-86, depotLaneZ - 12), max: pt(36, depotLaneZ + 44) },
      gate_node: depotGate,
      stands: [...parking, ...service],
      buildings: [
        {
          id: "depot-workshop",
          label: "Maintenance workshop",
          style: "workshop",
          min: pt(0, depotLaneZ + 15),
          max: pt(28, depotLaneZ + 40),
          height: 8,
        },
        {
          id: "depot-office",
          label: "Fleet office",
          style: "office",
          min: pt(-30, depotLaneZ + 16),
          max: pt(-14, depotLaneZ + 28),
          height: 4,
        },
      ],
      pallet_capacity: 0,
      handling_ticks_per_pallet: 1,
    },
    {
      id: PARK_SITES.gateway,
      kind: "gateway",
      name: "East highway gateway",
      bounds: { min: pt(232, avenueZ - 14), max: pt(276, avenueZ + 14) },
      gate_node: gw,
      stands: [],
      buildings: [],
      pallet_capacity: 0,
      handling_ticks_per_pallet: 1,
    },
  ];

  const vehicles: LinehaulVehicleConfig[] = parking.map((p, i) => ({
    id: `lh-${String(i + 1).padStart(2, "0")}`,
    label: `Line-haul truck LH-${String(i + 1).padStart(2, "0")}`,
    home_stand: p.id,
  }));

  return {
    name: "Northgate logistics park",
    primary_site: o.dcSiteId,
    sites,
    nodes: b.nodes,
    roads: b.roads,
    vehicles,
    lanes: o.lanes,
    service_interval_mm: 5_000_000,
    service_ticks: 900,
    off_network_ticks: 1800,
  };
}
