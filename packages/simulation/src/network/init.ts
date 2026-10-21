import type { SimulationConfig } from "../types";
import type { LinehaulState, NetworkState, SiteState } from "./model";

/**
 * Initial network state: opening stock at each site, every line-haul truck parked at its home
 * stall at the depot, no transfers.
 */
export function initialNetwork(config: SimulationConfig): NetworkState | undefined {
  const net = config.network;
  if (!net) return undefined;
  const home = new Map(net.vehicles.map((v) => [v.home_stand, v.id]));
  const sites: Record<string, SiteState> = {};
  for (const site of [...net.sites].sort((a, b) => a.id.localeCompare(b.id))) {
    const stock: Record<string, number> = {};
    for (const l of site.opening_stock ?? []) stock[l.sku] = (stock[l.sku] ?? 0) + l.quantity;
    const stands: Record<string, string | null> = {};
    for (const s of [...site.stands].sort((a, b) => a.id.localeCompare(b.id)))
      stands[s.id] = home.get(s.id) ?? null;
    sites[site.id] = {
      stock,
      allocated: {},
      incoming: 0,
      containers: site.containers?.opening ?? 0,
      devan_ticks_left: 0,
      devan_sku: null,
      stands,
      received: 0,
      dispatched: 0,
    };
  }
  const stands = new Map(net.sites.flatMap((s) => s.stands.map((x) => [x.id, { s, x }] as const)));
  const vehicles: Record<string, LinehaulState> = {};
  for (const v of [...net.vehicles].sort((a, b) => a.id.localeCompare(b.id))) {
    const at = stands.get(v.home_stand);
    if (!at) throw new Error(`invariant violated: unknown home stand ${v.home_stand}`);
    vehicles[v.id] = {
      id: v.id,
      status: "parked",
      node: at.x.approach_node,
      prev_node: null,
      route: [],
      progress_mm: 0,
      site_id: at.s.id,
      stand_id: at.x.id,
      target_stand: null,
      intent: null,
      manoeuvre_ticks_left: 0,
      transfer_id: null,
      cargo: [],
      handled: 0,
      timer_ticks: 0,
      dc_truck_id: null,
      dc_yard_slot: null,
      dc_dock_id: null,
      odometer_mm: 0,
      service_odometer_mm: 0,
      status_since_tick: 0,
    };
  }
  return { sites, vehicles, transfers: {}, next_transfer: 0 };
}
