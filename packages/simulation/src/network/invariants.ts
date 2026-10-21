import { TRUCK_CAPACITY } from "@warehouse-one/contracts";
import type { SimulationConfig, SimulationState } from "../types";
import { cargoTotal } from "./model";

const AT_STAND = new Set(["parked", "docking", "loading", "unloading", "servicing"]);

/** Network invariants (empty = healthy). Checked with the core invariants and on snapshot load. */
export function checkNetworkInvariants(config: SimulationConfig, state: SimulationState): string[] {
  const net = config.network;
  const s = state.network;
  if (!net) return s ? ["network state without network config"] : [];
  if (!s) return ["network config without network state"];
  const v: string[] = [];
  const sites = new Map(net.sites.map((x) => [x.id, x]));

  for (const [id, site] of Object.entries(s.sites)) {
    const cfg = sites.get(id);
    if (!cfg) {
      v.push(`state for unknown site ${id}`);
      continue;
    }
    let total = 0;
    for (const [sku, q] of Object.entries(site.stock)) {
      if (!Number.isInteger(q) || q <= 0) v.push(`site ${id} stock of ${sku} is ${q}`);
      total += q;
    }
    for (const [sku, q] of Object.entries(site.allocated)) {
      if (!Number.isInteger(q) || q <= 0) v.push(`site ${id} allocation of ${sku} is ${q}`);
      if (q > (site.stock[sku] ?? 0)) v.push(`site ${id} allocates more ${sku} than it holds`);
    }
    if (!Number.isInteger(site.incoming) || site.incoming < 0)
      v.push(`site ${id} incoming is ${site.incoming}`);
    if (
      cfg.kind !== "gateway" &&
      id !== net.primary_site &&
      total + site.incoming > cfg.pallet_capacity
    )
      v.push(
        `site ${id} over capacity (${total} + ${site.incoming} incoming / ${cfg.pallet_capacity})`,
      );
    if (site.containers < 0 || site.containers > (cfg.containers?.capacity ?? 0))
      v.push(`site ${id} holds ${site.containers} containers`);
    for (const [stand, holder] of Object.entries(site.stands)) {
      if (holder && !s.vehicles[holder]) v.push(`stand ${stand} held by unknown truck ${holder}`);
    }
  }

  const held = new Map<string, string>();
  for (const site of Object.values(s.sites))
    for (const [stand, holder] of Object.entries(site.stands)) if (holder) held.set(stand, holder);

  for (const t of Object.values(s.vehicles)) {
    if (cargoTotal(t.cargo) > TRUCK_CAPACITY) v.push(`truck ${t.id} over capacity`);
    if (t.stand_id && AT_STAND.has(t.status) && held.get(t.stand_id) !== t.id)
      v.push(`truck ${t.id} is ${t.status} at ${t.stand_id}, which is not held by it`);
    if (AT_STAND.has(t.status) && !t.stand_id)
      v.push(`truck ${t.id} is ${t.status} without a stand`);
    if (t.target_stand && held.get(t.target_stand) !== t.id)
      v.push(`truck ${t.id} heads for ${t.target_stand} without holding it`);
    if (t.status === "driving" && t.route.length === 0)
      v.push(`truck ${t.id} drives without a route`);
    if (t.status === "at_dc" && !state.ops?.trucks[t.dc_truck_id ?? ""])
      v.push(`truck ${t.id} is at the DC as ${t.dc_truck_id ?? "nothing"}, which is not on site`);
    if (t.transfer_id && s.transfers[t.transfer_id]?.vehicle_id !== t.id)
      v.push(`truck ${t.id} serves transfer ${t.transfer_id}, which is not assigned to it`);
    if (t.odometer_mm < t.service_odometer_mm) v.push(`truck ${t.id} odometer went backwards`);
  }
  for (const [stand, holder] of held) {
    const t = s.vehicles[holder];
    if (t && t.stand_id !== stand && t.target_stand !== stand)
      v.push(`stand ${stand} held by ${holder}, which is neither at it nor heading for it`);
  }
  for (const t of Object.values(s.transfers)) {
    if (!sites.has(t.from_site) || !sites.has(t.to_site))
      v.push(`transfer ${t.id} references an unknown site`);
    if (t.status === "planned" ? t.vehicle_id !== null : !t.vehicle_id)
      v.push(`transfer ${t.id} is ${t.status} with truck ${t.vehicle_id ?? "none"}`);
    if (t.vehicle_id && s.vehicles[t.vehicle_id]?.transfer_id !== t.id)
      v.push(`transfer ${t.id} truck ${t.vehicle_id} does not serve it`);
  }
  return v;
}
