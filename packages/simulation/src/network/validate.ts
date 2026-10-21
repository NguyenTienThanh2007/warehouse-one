import { EntityId, TRUCK_CAPACITY } from "@warehouse-one/contracts";
import type { SimulationConfig } from "../types";
import { roadGraph } from "./roads";

const RESERVED = /^(plt|tsk|trk|ord|xfr)-/;

/** Problems with `config.network` (empty = valid). Called only when the facility itself is valid. */
export function validateNetwork(config: SimulationConfig): string[] {
  const net = config.network;
  if (!net) return [];
  const problems: string[] = [];
  const slug = (id: string, what: string) => {
    if (!EntityId.safeParse(id).success) problems.push(`${what} id '${id}' is not a valid slug`);
    if (RESERVED.test(id)) problems.push(`${what} id '${id}' uses a reserved run-time id prefix`);
  };
  // Aggregate ids share one version table: sites and trucks must not reuse SKU or equipment ids.
  const taken = new Set<string>([
    ...config.skus.map((s) => s.id),
    ...(config.facility?.equipment.map((e) => e.id) ?? []),
    ...(config.facility?.docks.map((d) => d.id) ?? []),
  ]);
  const claim = (id: string, what: string) => {
    slug(id, what);
    if (taken.has(id)) problems.push(`duplicate id '${id}' (${what})`);
    taken.add(id);
  };

  const nodes = new Set<string>();
  for (const n of net.nodes) {
    slug(n.id, "road node");
    if (nodes.has(n.id)) problems.push(`duplicate road node '${n.id}'`);
    nodes.add(n.id);
  }
  const roadIds = new Set<string>();
  for (const r of net.roads) {
    if (roadIds.has(r.id)) problems.push(`duplicate road '${r.id}'`);
    roadIds.add(r.id);
    if (!nodes.has(r.from) || !nodes.has(r.to))
      problems.push(`road '${r.id}' references an unknown node`);
    if (r.from === r.to) problems.push(`road '${r.id}' starts and ends at the same node`);
  }

  const sites = new Map(net.sites.map((s) => [s.id, s]));
  const primary = sites.get(net.primary_site);
  if (!primary) problems.push(`primary site '${net.primary_site}' is not defined`);
  else if (primary.kind !== "distribution_center")
    problems.push("the primary site must be a distribution_center");
  const standOwner = new Map<string, string>();
  for (const site of net.sites) {
    claim(site.id, "site");
    if (!nodes.has(site.gate_node)) problems.push(`site '${site.id}' gate is not a road node`);
    if (site.kind === "distribution_center" && site.id !== net.primary_site)
      problems.push(`site '${site.id}': only the primary site can be a distribution centre`);
    if (!Number.isInteger(site.pallet_capacity) || site.pallet_capacity < 0)
      problems.push(`site '${site.id}' pallet_capacity must be a non-negative integer`);
    if (!Number.isInteger(site.handling_ticks_per_pallet) || site.handling_ticks_per_pallet < 1)
      problems.push(`site '${site.id}' handling_ticks_per_pallet must be a positive integer`);
    let opening = 0;
    for (const l of site.opening_stock ?? []) {
      if (!config.skus.some((s) => s.id === l.sku))
        problems.push(`site '${site.id}' opening stock has unknown sku '${l.sku}'`);
      if (!Number.isInteger(l.quantity) || l.quantity < 1)
        problems.push(`site '${site.id}' opening quantities must be positive integers`);
      opening += l.quantity;
    }
    if (site.id === net.primary_site && opening > 0)
      problems.push("the primary site's stock is its racking; give it no opening_stock");
    if (opening > site.pallet_capacity)
      problems.push(`site '${site.id}' opening stock exceeds its capacity`);
    for (const st of site.stands) {
      claim(st.id, "stand");
      standOwner.set(st.id, site.id);
      if (!nodes.has(st.approach_node))
        problems.push(`stand '${st.id}' approach is not a road node`);
    }
    const kinds = new Set(site.stands.map((s) => s.kind));
    if (site.id === net.primary_site && [...kinds].some((k) => k !== "staging"))
      problems.push("the primary site has staging stands only (its docks are the facility's)");
    if (site.id === net.primary_site && !kinds.has("staging"))
      problems.push("the primary site needs staging stands for trucks waiting for admission");
    if ((site.kind === "cross_dock" || site.kind === "container_terminal") && !kinds.has("door"))
      problems.push(`site '${site.id}' needs at least one door`);
    if (site.kind === "gateway" && site.stands.length > 0)
      problems.push(`gateway '${site.id}' has no stands`);
    const c = site.containers;
    if (c) {
      if (site.kind !== "container_terminal")
        problems.push(`site '${site.id}': only container terminals stack containers`);
      const ints = [c.capacity, c.opening, c.pallets_per_container, c.devan_ticks, c.devan_below];
      if (!ints.every((x) => Number.isInteger(x) && x >= 0) || c.pallets_per_container < 1)
        problems.push(`site '${site.id}' container settings must be non-negative integers`);
      if (c.opening > c.capacity)
        problems.push(`site '${site.id}' opening containers exceed capacity`);
      const v = c.vessel;
      if (!(
        Number.isInteger(v.interval_ticks) &&
        v.interval_ticks >= 0 &&
        v.min >= 0 &&
        v.max >= v.min
      ))
        problems.push(`site '${site.id}' vessel schedule is invalid`);
    }
  }

  const homes = new Set<string>();
  for (const v of net.vehicles) {
    claim(v.id, "line-haul truck");
    const site = sites.get(standOwner.get(v.home_stand) ?? "");
    const stand = site?.stands.find((s) => s.id === v.home_stand);
    if (!site || site.kind !== "fleet_depot" || stand?.kind !== "parking")
      problems.push(`truck '${v.id}' home must be a parking stand at a fleet depot`);
    if (homes.has(v.home_stand)) problems.push(`stand '${v.home_stand}' is home to two trucks`);
    homes.add(v.home_stand);
  }
  for (const site of net.sites) {
    const parking = site.stands.filter((s) => s.kind === "parking" && !homes.has(s.id));
    if (parking.length > 0)
      problems.push(
        `site '${site.id}' parking stands without a truck: ${parking.map((s) => s.id).join(", ")}`,
      );
  }

  for (const lane of net.lanes) {
    claim(lane.id, "lane");
    const from = sites.get(lane.from_site);
    const to = sites.get(lane.to_site);
    if (!from || !to) problems.push(`lane '${lane.id}' references an unknown site`);
    else {
      if (from.kind === "gateway" || from.kind === "fleet_depot")
        problems.push(`lane '${lane.id}' cannot start at a ${from.kind}`);
      if (to.kind === "fleet_depot") problems.push(`lane '${lane.id}' cannot end at a fleet depot`);
      if (from.id === to.id) problems.push(`lane '${lane.id}' starts and ends at the same site`);
    }
    if (!Number.isInteger(lane.interval_ticks) || lane.interval_ticks < 0)
      problems.push(`lane '${lane.id}' interval must be a non-negative integer`);
    if (
      !(Number.isInteger(lane.min_pallets) && lane.min_pallets >= 1) ||
      !(Number.isInteger(lane.max_pallets) && lane.max_pallets >= lane.min_pallets) ||
      lane.max_pallets > TRUCK_CAPACITY
    )
      problems.push(`lane '${lane.id}' pallets must satisfy 1 <= min <= max <= ${TRUCK_CAPACITY}`);
    if (!Number.isInteger(lane.max_open) || lane.max_open < 1)
      problems.push(`lane '${lane.id}' max_open must be >= 1`);
  }
  for (const [k, v] of [
    ["service_interval_mm", net.service_interval_mm],
    ["service_ticks", net.service_ticks],
    ["off_network_ticks", net.off_network_ticks],
  ] as const) {
    if (!Number.isInteger(v) || v < 1) problems.push(`network ${k} must be a positive integer`);
  }

  // Every gate and stand must be reachable from every other one.
  if (problems.length === 0) {
    const g = roadGraph(config);
    const points = [
      ...net.sites.map((s) => s.gate_node),
      ...net.sites.flatMap((s) => s.stands.map((x) => x.approach_node)),
    ];
    const from = points[0];
    for (const p of points) {
      if (from !== undefined && g.distance(from, p) === null)
        problems.push(`road node '${p}' is not connected to the rest of the network`);
    }
  }
  return problems;
}
