import type {
  CargoLine,
  LinehaulStatus,
  SimulationCommand,
  TransferStatus,
} from "@warehouse-one/contracts";
import { applyOpsCommand } from "../ops/commands";
import type { OpsDraft } from "../ops/ops-draft";
import { availablePallets, freeStorage, freeYardSlot, inboundBacklog } from "../ops/tasks";
import type { RejectionCode } from "../types";
import type { NetworkDraft } from "./draft";
import {
  cargoTotal,
  DC_ENTER_TICKS,
  DC_LEAVE_TICKS,
  DC_ORIGIN_MAX_WAIT_TICKS,
  DOCK_TICKS,
  HEADWAY_MM,
  RETRY_TICKS,
  ROAD_SPEED_MM_PER_TICK,
  UNDOCK_TICKS,
  type Intent,
  type LinehaulState,
  type SiteConfig,
  type SiteState,
  type StandKind,
  type TransferState,
} from "./model";
import { edgeKey, edgeLength } from "./roads";

/**
 * The logistics-network system, run every tick after the facility's operations systems:
 *   sites (vessel calls, devanning) → lanes (plan transfers) → trucks (move, manoeuvre, handle,
 *   hand over to / take back from the DC) → assignment (planned transfers to idle trucks) →
 *   idle trucks (service or return home).
 * Trucks and transfers are processed in id order; random draws happen only when work is due.
 */
export function networkSystem(n: NetworkDraft): void {
  sitesSystem(n);
  laneSystem(n);
  for (const id of Object.keys(n.vehicles.snapshot()).sort()) vehicleStep(n, id);
  assignSystem(n);
  idleSystem(n);
}

// ---------------------------------------------------------------------------------------------
// Helpers: traces, events, stock

const SYSTEM = "system:network";

function traceOf(n: NetworkDraft, transferId: string | null) {
  const t = transferId ? n.transfers.get(transferId) : undefined;
  return { correlation_id: t?.correlation_id ?? `sys-net-t${n.tick}`, causation_id: SYSTEM };
}

/** Write a truck; a status change emits `linehaul.status_changed`. */
function put(n: NetworkDraft, v: LinehaulState, patch: Partial<LinehaulState>): LinehaulState {
  const next: LinehaulState = { ...v, ...patch };
  const changed = patch.status !== undefined && patch.status !== v.status;
  const written = changed ? { ...next, status_since_tick: n.tick } : next;
  n.vehicles.set(v.id, written);
  if (changed) {
    n.draft.emit(
      "linehaul.status_changed",
      v.id,
      {
        vehicle_id: v.id,
        from: v.status,
        to: written.status,
        node_id: written.node,
        site_id: written.site_id,
        transfer_id: written.transfer_id,
        odometer_m: Math.floor(written.odometer_mm / 1000),
      },
      traceOf(n, written.transfer_id ?? v.transfer_id),
    );
  }
  return written;
}

function setTransfer(
  n: NetworkDraft,
  t: TransferState,
  to: TransferStatus,
  vehicleId = t.vehicle_id,
) {
  n.draft.emit(
    "transfer.status_changed",
    t.id,
    {
      transfer_id: t.id,
      lane_id: t.lane_id,
      from_site_id: t.from_site,
      to_site_id: t.to_site,
      from: t.status,
      to,
      vehicle_id: vehicleId,
      lines: [...t.lines],
    },
    { correlation_id: t.correlation_id, causation_id: SYSTEM },
  );
  if (to === "delivered" || to === "cancelled") n.transfers.delete(t.id);
  else n.transfers.set(t.id, { ...t, status: to, vehicle_id: vehicleId });
}

function bump(rec: Readonly<Record<string, number>>, key: string, delta: number) {
  const out = { ...rec };
  const v = (out[key] ?? 0) + delta;
  if (!Number.isInteger(v) || v < 0) throw new Error(`invariant violated: ${key} count ${v}`);
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- fresh copy owned by this tick
  if (v === 0) delete out[key];
  else out[key] = v;
  return out;
}

function changeStock(
  n: NetworkDraft,
  siteId: string,
  sku: string,
  delta: number,
  reason: "loaded" | "unloaded" | "devanned",
  transferId: string | null,
  extra: Partial<SiteState> = {},
) {
  const s = n.site(siteId);
  const stock = bump(s.stock, sku, delta);
  n.sites.set(siteId, { ...s, ...extra, stock });
  n.draft.emit(
    "site.stock_changed",
    siteId,
    {
      site_id: siteId,
      unit: "pallet",
      sku,
      delta,
      quantity_after: stock[sku] ?? 0,
      reason,
      transfer_id: transferId,
    },
    traceOf(n, transferId),
  );
}

export const stockTotal = (s: SiteState) => Object.values(s.stock).reduce((a, b) => a + b, 0);

function ops(n: NetworkDraft): OpsDraft {
  const o = n.draft.ops;
  if (!o) throw new Error("invariant violated: network without facility operations");
  return o;
}

const isPrimary = (n: NetworkDraft, siteId: string) => siteId === n.config.primary_site;

// ---------------------------------------------------------------------------------------------
// Sites: container terminal vessel calls and devanning

function sitesSystem(n: NetworkDraft): void {
  for (const site of n.config.sites) {
    const c = site.containers;
    if (!c) continue;
    let s = n.site(site.id);
    const v = c.vessel;
    if (v.interval_ticks > 0 && n.tick % v.interval_ticks === v.phase_ticks % v.interval_ticks) {
      const add = Math.min(n.draft.randomInt(v.min, v.max), c.capacity - s.containers);
      if (add > 0) {
        s = { ...s, containers: s.containers + add };
        n.sites.set(site.id, s);
        emitContainers(n, site.id, add, s.containers, "vessel_discharge");
      }
    }
    if (s.devan_ticks_left > 0) {
      const left = s.devan_ticks_left - 1;
      if (left > 0) {
        n.sites.set(site.id, { ...s, devan_ticks_left: left });
      } else {
        const sku = s.devan_sku as string;
        changeStock(n, site.id, sku, c.pallets_per_container, "devanned", null, {
          devan_ticks_left: 0,
          devan_sku: null,
        });
      }
      continue;
    }
    const total = stockTotal(s);
    if (
      s.containers > 0 &&
      total < c.devan_below &&
      total + s.incoming + c.pallets_per_container <= site.pallet_capacity
    ) {
      const skus = n.draft.config.skus;
      const sku = skus[n.draft.randomInt(0, skus.length - 1)]?.id as string;
      const next = {
        ...s,
        containers: s.containers - 1,
        devan_ticks_left: c.devan_ticks,
        devan_sku: sku,
      };
      n.sites.set(site.id, next);
      emitContainers(n, site.id, -1, next.containers, "devanned");
    }
  }
}

function emitContainers(
  n: NetworkDraft,
  siteId: string,
  delta: number,
  after: number,
  reason: "vessel_discharge" | "devanned",
) {
  n.draft.emit(
    "site.stock_changed",
    siteId,
    {
      site_id: siteId,
      unit: "container",
      sku: null,
      delta,
      quantity_after: after,
      reason,
      transfer_id: null,
    },
    { correlation_id: `sys-net-t${n.tick}`, causation_id: SYSTEM },
  );
}

// ---------------------------------------------------------------------------------------------
// Planning: availability at the origin, room at the destination

/** Pallets of `sku` the site can still promise to new transfers. */
export function availableAt(n: NetworkDraft, siteId: string, sku: string): number {
  if (isPrimary(n, siteId)) {
    let earmarked = 0;
    for (const t of n.transfers.values()) {
      // DC stock is allocated by the DC's own order once the truck is admitted.
      if (t.from_site === siteId && (t.status === "planned" || t.status === "assigned"))
        earmarked += t.lines.find((l) => l.sku === sku)?.quantity ?? 0;
    }
    return availablePallets(ops(n), sku).length - earmarked;
  }
  const s = n.site(siteId);
  return (s.stock[sku] ?? 0) - (s.allocated[sku] ?? 0);
}

/** Pallets the site can still accept from new transfers. */
export function roomAt(n: NetworkDraft, siteId: string): number {
  const site = n.index.sites.get(siteId) as SiteConfig;
  if (site.kind === "gateway") return Number.MAX_SAFE_INTEGER;
  if (isPrimary(n, siteId)) {
    let pending = 0;
    for (const t of n.transfers.values())
      if (t.to_site === siteId && t.status !== "unloading") pending += cargoTotal(t.lines);
    const o = ops(n);
    return freeStorage(o) - inboundBacklog(o) - pending;
  }
  const s = n.site(siteId);
  return site.pallet_capacity - stockTotal(s) - s.incoming;
}

export type PlanResult =
  { ok: true; id: string } | { ok: false; code: RejectionCode; message: string };

/** Create a planned transfer and reserve its stock and capacity. Validates before writing. */
export function planTransfer(
  n: NetworkDraft,
  p: {
    lane_id: string | null;
    from: string;
    to: string;
    lines: readonly CargoLine[];
    correlation_id: string;
  },
): PlanResult {
  const from = n.index.sites.get(p.from);
  const to = n.index.sites.get(p.to);
  if (!from) return { ok: false, code: "UNKNOWN_SITE", message: `unknown site '${p.from}'` };
  if (!to) return { ok: false, code: "UNKNOWN_SITE", message: `unknown site '${p.to}'` };
  if (from.kind === "gateway" || from.kind === "fleet_depot")
    return {
      ok: false,
      code: "INVALID_TRANSFER",
      message: `'${from.name}' does not ship pallets (it is a ${from.kind.replace("_", " ")})`,
    };
  if (to.kind === "fleet_depot")
    return {
      ok: false,
      code: "INVALID_TRANSFER",
      message: `'${to.name}' does not receive pallets`,
    };
  for (const l of p.lines) {
    if (!n.draft.skuIds.has(l.sku))
      return { ok: false, code: "UNKNOWN_SKU", message: `unknown sku '${l.sku}'` };
    const free = availableAt(n, p.from, l.sku);
    if (free < l.quantity)
      return {
        ok: false,
        code: "INSUFFICIENT_STOCK",
        message: `'${from.name}' can ship ${Math.max(0, free)} pallets of '${l.sku}', ${l.quantity} requested`,
      };
  }
  const total = cargoTotal(p.lines);
  const room = roomAt(n, p.to);
  if (room < total)
    return {
      ok: false,
      code: "NO_CAPACITY",
      message: `'${to.name}' can accept ${Math.max(0, room)} more pallets, transfer carries ${total}`,
    };

  const id = n.newTransferId();
  if (!isPrimary(n, p.from)) {
    let s = n.site(p.from);
    for (const l of p.lines) s = { ...s, allocated: bump(s.allocated, l.sku, l.quantity) };
    n.sites.set(p.from, s);
  }
  if (!isPrimary(n, p.to) && to.kind !== "gateway") {
    const s = n.site(p.to);
    n.sites.set(p.to, { ...s, incoming: s.incoming + total });
  }
  const t: TransferState = {
    id,
    lane_id: p.lane_id,
    from_site: p.from,
    to_site: p.to,
    lines: p.lines,
    status: "planned",
    vehicle_id: null,
    created_tick: n.tick,
    correlation_id: p.correlation_id,
  };
  n.transfers.set(id, t);
  n.draft.emit(
    "transfer.status_changed",
    id,
    {
      transfer_id: id,
      lane_id: p.lane_id,
      from_site_id: p.from,
      to_site_id: p.to,
      from: null,
      to: "planned",
      vehicle_id: null,
      lines: [...p.lines],
    },
    { correlation_id: p.correlation_id, causation_id: p.lane_id ? SYSTEM : p.correlation_id },
  );
  return { ok: true, id };
}

function laneSystem(n: NetworkDraft): void {
  for (const lane of [...n.config.lanes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (lane.interval_ticks <= 0) continue;
    if (n.tick % lane.interval_ticks !== lane.phase_ticks % lane.interval_ticks) continue;
    const open = n.transfers.values().filter((t) => t.lane_id === lane.id).length;
    if (open >= lane.max_open) continue;
    const wanted = Math.min(
      n.draft.randomInt(lane.min_pallets, lane.max_pallets),
      roomAt(n, lane.to_site),
    );
    const left = new Map(
      n.draft.config.skus.map((s) => [s.id, availableAt(n, lane.from_site, s.id)]),
    );
    const counts = new Map<string, number>();
    for (let i = 0; i < wanted; i++) {
      const stocked = [...left.keys()].filter((s) => (left.get(s) ?? 0) > 0);
      if (stocked.length === 0) break;
      const sku = stocked[n.draft.randomInt(0, stocked.length - 1)] as string;
      left.set(sku, (left.get(sku) ?? 0) - 1);
      counts.set(sku, (counts.get(sku) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    const lines = [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sku, quantity]) => ({ sku, quantity }));
    planTransfer(n, {
      lane_id: lane.id,
      from: lane.from_site,
      to: lane.to_site,
      lines,
      correlation_id: `lane-${lane.id}-t${n.tick}`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Stands

/** Free door for a role (inbound doors receive, outbound doors dispatch), else any free door. */
function freeDoor(n: NetworkDraft, siteId: string, role: "inbound" | "outbound"): string | null {
  const site = n.index.sites.get(siteId) as SiteConfig;
  const state = n.site(siteId);
  const doors = site.stands
    .filter((s) => s.kind === "door" && !state.stands[s.id])
    .sort((a, b) => a.id.localeCompare(b.id));
  return (doors.find((d) => d.role === role) ?? doors[0])?.id ?? null;
}

/** Lowest-id free stand of a kind at a site (or null). */
function freeStand(n: NetworkDraft, siteId: string, kind: StandKind): string | null {
  const site = n.index.sites.get(siteId) as SiteConfig;
  const state = n.site(siteId);
  const ids = site.stands
    .filter((s) => s.kind === kind)
    .map((s) => s.id)
    .sort();
  return ids.find((id) => !state.stands[id]) ?? null;
}

function holdStand(n: NetworkDraft, standId: string, vehicleId: string | null) {
  const { site } = n.index.stands.get(standId) as { site: SiteConfig };
  const s = n.site(site.id);
  n.sites.set(site.id, { ...s, stands: { ...s.stands, [standId]: vehicleId } });
}

const standKind = (n: NetworkDraft, id: string) => n.index.stands.get(id)?.stand.kind;
const standSite = (n: NetworkDraft, id: string) => n.index.stands.get(id)?.site.id as string;
const approachOf = (n: NetworkDraft, id: string) =>
  n.index.stands.get(id)?.stand.approach_node as string;

/**
 * Send a truck towards `node` with an intent. A truck standing somewhere first undocks (and
 * releases that stand unless it is the target); a truck on the road drives off at once.
 */
function travel(
  n: NetworkDraft,
  v: LinehaulState,
  node: string,
  intent: Intent,
  target: string | null,
  extra: Partial<LinehaulState> = {},
): LinehaulState {
  const route = n.graph.route(v.node, node);
  if (!route) throw new Error(`invariant violated: no road from ${v.node} to ${node}`);
  if (v.stand_id) {
    return put(n, v, {
      status: "undocking",
      route,
      progress_mm: 0,
      target_stand: target,
      intent,
      manoeuvre_ticks_left: UNDOCK_TICKS,
      ...extra,
    });
  }
  const next = put(n, v, {
    status: route.length ? "driving" : v.status,
    route,
    progress_mm: 0,
    site_id: route.length ? null : v.site_id,
    target_stand: target,
    intent,
    ...extra,
  });
  return route.length ? next : arrive(n, next);
}

// ---------------------------------------------------------------------------------------------
// Truck step

function vehicleStep(n: NetworkDraft, id: string): void {
  const v = n.vehicle(id);
  switch (v.status) {
    case "driving":
      drive(n, v);
      return;
    case "docking": {
      if (v.manoeuvre_ticks_left > 1) {
        n.vehicles.set(v.id, { ...v, manoeuvre_ticks_left: v.manoeuvre_ticks_left - 1 });
        return;
      }
      docked(n, { ...v, manoeuvre_ticks_left: 0 });
      return;
    }
    case "undocking": {
      if (v.manoeuvre_ticks_left > 1) {
        n.vehicles.set(v.id, { ...v, manoeuvre_ticks_left: v.manoeuvre_ticks_left - 1 });
        return;
      }
      undocked(n, { ...v, manoeuvre_ticks_left: 0 });
      return;
    }
    case "loading":
    case "unloading":
      handle(n, v);
      return;
    case "waiting":
      if (v.timer_ticks > 1) {
        n.vehicles.set(v.id, { ...v, timer_ticks: v.timer_ticks - 1 });
        return;
      }
      retry(n, { ...v, timer_ticks: 0 });
      return;
    case "servicing":
      if (v.timer_ticks > 1) {
        n.vehicles.set(v.id, { ...v, timer_ticks: v.timer_ticks - 1 });
        return;
      }
      put(n, v, {
        status: "parked",
        timer_ticks: 0,
        service_odometer_mm: v.odometer_mm,
        intent: null,
      });
      return;
    case "off_network":
      if (v.timer_ticks > 1) {
        n.vehicles.set(v.id, { ...v, timer_ticks: v.timer_ticks - 1 });
        return;
      }
      // Back from the last-mile run: idle at the gateway until assigned or sent home.
      put(n, v, { status: "waiting", timer_ticks: 0, intent: null });
      return;
    case "at_dc":
      atDc(n, v);
      return;
    case "parked":
      return;
  }
}

/** Move along the route at the road's speed, keeping a headway behind trucks going the same way. */
function drive(n: NetworkDraft, start: LinehaulState): void {
  const g = n.graph;
  let v = start;
  let budget = 0;
  const next0 = v.route[0];
  if (next0) {
    const road = g.roads.get(edgeKey(v.node, next0));
    budget = ROAD_SPEED_MM_PER_TICK[road?.kind ?? "service"];
  }
  let moved = 0;
  let node = v.node;
  let prev = v.prev_node;
  let progress = v.progress_mm;
  const route = [...v.route];
  while (budget > 0 && route.length > 0) {
    const to = route[0] as string;
    const length = edgeLength(g, node, to);
    const cap = headroom(n, v.id, node, to, progress);
    const step = Math.min(budget, length - progress, Math.max(0, cap - progress));
    if (step <= 0) break;
    progress += step;
    budget -= step;
    moved += step;
    if (progress < length) break;
    prev = node;
    node = to;
    route.shift();
    progress = 0;
    const nxt = route[0];
    // Speed changes at the node: the rest of this tick runs at the next road's speed.
    if (nxt) {
      const kind = g.roads.get(edgeKey(node, nxt))?.kind ?? "service";
      budget = Math.min(budget, ROAD_SPEED_MM_PER_TICK[kind]);
    }
  }
  v = {
    ...v,
    node,
    prev_node: prev,
    route,
    progress_mm: progress,
    odometer_mm: v.odometer_mm + moved,
  };
  n.vehicles.set(v.id, v);
  if (route.length === 0) arrive(n, v);
}

/** Farthest progress allowed on edge from→to: a headway behind the nearest truck ahead. */
function headroom(n: NetworkDraft, self: string, from: string, to: string, progress: number) {
  let cap = Number.MAX_SAFE_INTEGER;
  for (const u of n.vehicles.values()) {
    if (u.id === self || u.status !== "driving") continue;
    if (u.node !== from || u.route[0] !== to) continue;
    // Equal progress (both at the node): the lower id goes first, so two trucks never block each other.
    if (u.progress_mm < progress || (u.progress_mm === progress && u.id > self)) continue;
    cap = Math.min(cap, u.progress_mm - HEADWAY_MM);
  }
  return cap;
}

/** End of route: dock at the target stand, enter the DC, or leave the world at the gateway. */
function arrive(n: NetworkDraft, v: LinehaulState): LinehaulState {
  if (v.intent === "enter_dc" && v.node === n.index.primary.gate_node) {
    if (admitToDc(n, v)) return n.vehicle(v.id);
    // Not admitted: wait at the reserved staging stall and retry.
    const stall = v.target_stand as string;
    return travel(n, n.vehicle(v.id), approachOf(n, stall), "enter_dc", stall);
  }
  if (v.intent === "exit") return exitWorld(n, v);
  if (v.target_stand) {
    return put(n, v, {
      status: "docking",
      stand_id: v.target_stand,
      target_stand: null,
      site_id: standSite(n, v.target_stand),
      manoeuvre_ticks_left: DOCK_TICKS,
    });
  }
  return put(n, v, { status: "waiting", timer_ticks: 0, intent: null });
}

/** Manoeuvre into the stand finished: start the intended activity. */
function docked(n: NetworkDraft, v: LinehaulState): void {
  const stand = v.stand_id as string;
  const kind = standKind(n, stand);
  if (kind === "parking") {
    put(n, v, { status: "parked", intent: null });
    return;
  }
  if (kind === "service") {
    put(n, v, { status: "servicing", intent: null, timer_ticks: n.config.service_ticks });
    return;
  }
  if (kind === "staging") {
    put(n, v, { status: "waiting", timer_ticks: RETRY_TICKS });
    return;
  }
  startHandling(n, v);
}

function startHandling(n: NetworkDraft, v: LinehaulState): void {
  const t = n.transfers.get(v.transfer_id as string) as TransferState;
  const site = n.index.sites.get(v.site_id as string) as SiteConfig;
  const loading = v.intent === "load";
  setTransfer(n, t, loading ? "loading" : "unloading");
  put(n, v, {
    status: loading ? "loading" : "unloading",
    handled: 0,
    timer_ticks: site.handling_ticks_per_pallet,
  });
}

/** One pallet every `handling_ticks_per_pallet`; stock changes when the whole load is done. */
function handle(n: NetworkDraft, v: LinehaulState): void {
  if (v.timer_ticks > 1) {
    n.vehicles.set(v.id, { ...v, timer_ticks: v.timer_ticks - 1 });
    return;
  }
  const t = n.transfers.get(v.transfer_id as string) as TransferState;
  const total = cargoTotal(t.lines);
  const site = n.index.sites.get(v.site_id as string) as SiteConfig;
  const handled = v.handled + 1;
  if (handled < total) {
    n.vehicles.set(v.id, { ...v, handled, timer_ticks: site.handling_ticks_per_pallet });
    return;
  }
  if (v.status === "loading") {
    for (const l of t.lines) {
      const s = n.site(site.id);
      changeStock(n, site.id, l.sku, -l.quantity, "loaded", t.id, {
        allocated: bump(s.allocated, l.sku, -l.quantity),
      });
    }
    const s = n.site(site.id);
    n.sites.set(site.id, { ...s, dispatched: s.dispatched + total });
    const loaded = put(n, v, { cargo: t.lines, handled: 0, timer_ticks: 0, intent: "depart" });
    depart(n, loaded);
    return;
  }
  for (const l of t.lines) changeStock(n, site.id, l.sku, l.quantity, "unloaded", t.id);
  const s = n.site(site.id);
  n.sites.set(site.id, { ...s, incoming: s.incoming - total, received: s.received + total });
  setTransfer(n, t, "delivered");
  // Idle at the door: the assignment or idle system moves it on this tick.
  put(n, v, {
    status: "parked",
    cargo: [],
    handled: 0,
    timer_ticks: 0,
    transfer_id: null,
    intent: null,
  });
}

/**
 * A loaded truck leaves for the destination. It reserves a stand there first (a door, else a
 * staging stall; at the DC a staging stall as fallback for admission), so it never arrives
 * without a place to stand. Without one it waits where it is and retries.
 */
function depart(n: NetworkDraft, v: LinehaulState): boolean {
  const t = n.transfers.get(v.transfer_id as string) as TransferState;
  const dest = n.index.sites.get(t.to_site) as SiteConfig;
  let node: string;
  let intent: Intent;
  let target: string | null = null;
  if (dest.kind === "gateway") {
    node = dest.gate_node;
    intent = "exit";
  } else if (isPrimary(n, dest.id)) {
    target = freeStand(n, dest.id, "staging");
    node = dest.gate_node;
    intent = "enter_dc";
  } else {
    target = freeDoor(n, dest.id, "inbound") ?? freeStand(n, dest.id, "staging");
    node = target ? approachOf(n, target) : "";
    intent = "unload";
  }
  if (dest.kind !== "gateway" && !target) {
    waitHere(n, v, "depart");
    return false;
  }
  if (target) holdStand(n, target, v.id);
  if (t.status === "loading") setTransfer(n, t, "in_transit");
  if (v.stand_id) holdStand(n, v.stand_id, null);
  travel(n, n.vehicle(v.id), node, intent, target);
  return true;
}

/** Wait at the current stand (or on the road) and retry after RETRY_TICKS. */
function waitHere(n: NetworkDraft, v: LinehaulState, intent: Intent) {
  put(n, v, { status: "waiting", intent, timer_ticks: RETRY_TICKS });
}

function retry(n: NetworkDraft, v: LinehaulState): void {
  switch (v.intent) {
    case "depart": {
      if (depart(n, v)) return;
      if (!v.stand_id && v.node === n.index.primary.gate_node) {
        // Left the DC loaded with nowhere to go yet: get off the road onto a staging stall.
        const stall = freeStand(n, n.index.primary.id, "staging");
        if (stall) {
          holdStand(n, stall, v.id);
          travel(n, n.vehicle(v.id), approachOf(n, stall), "depart", stall);
        }
      }
      return;
    }
    case "load":
    case "unload": {
      const door = freeDoor(n, v.site_id as string, v.intent === "load" ? "outbound" : "inbound");
      if (!door) {
        waitHere(n, v, v.intent);
        return;
      }
      holdStand(n, door, v.id);
      if (v.stand_id) holdStand(n, v.stand_id, null);
      travel(n, v, approachOf(n, door), v.intent, door);
      return;
    }
    case "enter_dc": {
      const t = n.transfers.get(v.transfer_id as string) as TransferState;
      if (
        t.from_site === n.config.primary_site &&
        n.tick - v.status_since_tick >= DC_ORIGIN_MAX_WAIT_TICKS
      ) {
        // The DC could not supply the pallets for too long: give the work up.
        setTransfer(n, t, "cancelled");
        put(n, v, { status: "waiting", transfer_id: null, intent: null, timer_ticks: 0 });
        return;
      }
      if (!dcAdmissible(n, v)) {
        // Keep the original waiting start, so the cancellation clock is not reset.
        n.vehicles.set(v.id, { ...v, timer_ticks: RETRY_TICKS });
        return;
      }
      // Drive to the gate keeping the stall reserved, in case admission fails after all.
      travel(n, v, n.index.primary.gate_node, "enter_dc", v.stand_id);
      return;
    }
    default:
      // Idle: the assignment and idle systems decide.
      return;
  }
}

function undocked(n: NetworkDraft, v: LinehaulState): void {
  // Release the stand left behind, unless it stays reserved as this trip's fallback.
  if (
    v.stand_id &&
    v.stand_id !== v.target_stand &&
    n.site(standSite(n, v.stand_id)).stands[v.stand_id] === v.id
  )
    holdStand(n, v.stand_id, null);
  const out = { ...v, stand_id: null, dc_dock_id: null };
  if (out.route.length > 0) {
    put(n, out, { status: "driving", site_id: null });
    return;
  }
  if (out.intent === "depart") {
    // Leaving the DC loaded.
    const w = put(n, out, { status: "waiting", timer_ticks: 0 });
    retry(n, w);
    return;
  }
  if (out.intent === "enter_dc" || out.intent === "exit" || out.target_stand) {
    arrive(n, put(n, out, { status: "driving", site_id: null }));
    return;
  }
  put(n, out, { status: "waiting", timer_ticks: 0, intent: null });
}

// ---------------------------------------------------------------------------------------------
// Distribution centre hand-over

/** Would the DC accept this truck now? (Same checks as `order.create` / `truck.schedule_inbound`.) */
function dcAdmissible(n: NetworkDraft, v: LinehaulState): boolean {
  const o = ops(n);
  if (freeYardSlot(o) === null) return false;
  const t = n.transfers.get(v.transfer_id as string) as TransferState;
  if (t.from_site === n.config.primary_site)
    return t.lines.every((l) => availablePallets(o, l.sku).length >= l.quantity);
  return freeStorage(o) - inboundBacklog(o) >= cargoTotal(v.cargo);
}

/**
 * Hand the truck to the facility simulation through the normal command handlers: an outbound
 * order (DC is the origin) or an inbound truck (DC is the destination). Every DC rule applies; a
 * rejection leaves no partial state.
 */
function admitToDc(n: NetworkDraft, v: LinehaulState): boolean {
  const o = ops(n);
  const t = n.transfers.get(v.transfer_id as string) as TransferState;
  const outbound = t.from_site === n.config.primary_site;
  const command = (
    outbound
      ? { command_id: `net-${t.id}-t${n.tick}`, type: "order.create", payload: { lines: t.lines } }
      : {
          command_id: `net-${t.id}-t${n.tick}`,
          type: "truck.schedule_inbound",
          payload: { cargo: v.cargo },
        }
  ) as SimulationCommand;
  const result = applyOpsCommand(o, command, {
    correlation_id: t.correlation_id,
    causation_id: SYSTEM,
  });
  if (!result.ok) return false;
  const truckId = o.lastId("truck");
  const truck = o.trucks.get(truckId);
  if (!truck) throw new Error(`invariant violated: admitted truck ${truckId} missing`);
  o.trucks.set(truckId, { ...truck, hold_ticks_left: DC_ENTER_TICKS });
  if (v.target_stand) holdStand(n, v.target_stand, null);
  setTransfer(n, t, outbound ? "loading" : "unloading");
  put(n, v, {
    status: "at_dc",
    site_id: n.config.primary_site,
    target_stand: null,
    intent: null,
    cargo: outbound ? v.cargo : [],
    dc_truck_id: truckId,
    dc_yard_slot: truck.yard_slot,
    dc_dock_id: null,
  });
  return true;
}

/** While at the DC: follow the facility's truck; take over again once it has departed. */
function atDc(n: NetworkDraft, v: LinehaulState): void {
  const o = ops(n);
  const truck = o.trucks.get(v.dc_truck_id as string);
  if (truck) {
    if (truck.dock_id && truck.dock_id !== v.dc_dock_id)
      n.vehicles.set(v.id, { ...v, dc_dock_id: truck.dock_id });
    return;
  }
  const t = n.transfers.get(v.transfer_id as string) as TransferState;
  const dc = n.site(n.config.primary_site);
  const total = cargoTotal(t.lines);
  const leaving: Partial<LinehaulState> = {
    status: "undocking",
    node: n.index.primary.gate_node,
    prev_node: null,
    route: [],
    progress_mm: 0,
    manoeuvre_ticks_left: DC_LEAVE_TICKS,
    dc_truck_id: null,
    dc_yard_slot: null,
  };
  if (t.from_site === n.config.primary_site) {
    // The DC's truck left with the order: the pallets are on this trailer now.
    n.sites.set(n.config.primary_site, { ...dc, dispatched: dc.dispatched + total });
    setTransfer(n, t, "in_transit");
    put(n, v, { ...leaving, cargo: t.lines, intent: "depart" });
  } else {
    n.sites.set(n.config.primary_site, { ...dc, received: dc.received + total });
    setTransfer(n, t, "delivered");
    put(n, v, { ...leaving, transfer_id: null, intent: null });
  }
}

/** Last-mile delivery: the pallets leave the modelled world at the gateway. */
function exitWorld(n: NetworkDraft, v: LinehaulState): LinehaulState {
  const t = n.transfers.get(v.transfer_id as string) as TransferState;
  const site = n.index.sites.get(t.to_site) as SiteConfig;
  const s = n.site(site.id);
  n.sites.set(site.id, { ...s, received: s.received + cargoTotal(t.lines) });
  setTransfer(n, t, "delivered");
  return put(n, v, {
    status: "off_network",
    site_id: site.id,
    cargo: [],
    transfer_id: null,
    intent: null,
    timer_ticks: n.config.off_network_ticks,
  });
}

// ---------------------------------------------------------------------------------------------
// Assignment and idle trucks

const IDLE: readonly LinehaulStatus[] = ["parked", "waiting"];

export function isIdle(v: LinehaulState): boolean {
  return IDLE.includes(v.status) && v.transfer_id === null && v.intent === null;
}

const serviceDue = (n: NetworkDraft, v: LinehaulState) =>
  v.odometer_mm - v.service_odometer_mm >= n.config.service_interval_mm;

function assignSystem(n: NetworkDraft): void {
  for (const t of n.transfers.sorted()) {
    if (t.status !== "planned") continue;
    const origin = n.index.sites.get(t.from_site) as SiteConfig;
    const candidates = n.vehicles
      .sorted()
      .filter((v) => isIdle(v) && !serviceDue(n, v))
      .map((v) => {
        // A truck already at a door of the origin loads right there.
        const there =
          v.stand_id &&
          standSite(n, v.stand_id) === origin.id &&
          standKind(n, v.stand_id) === "door";
        return { v, d: there ? -1 : (n.graph.distance(v.node, origin.gate_node) ?? Infinity) };
      })
      .sort((a, b) => a.d - b.d || a.v.id.localeCompare(b.v.id));
    const pick = candidates[0];
    if (!pick || pick.d === Infinity) continue;
    startTrip(n, pick.v, t, pick.d === -1);
  }
}

function startTrip(n: NetworkDraft, v: LinehaulState, t: TransferState, here: boolean): void {
  const origin = n.index.sites.get(t.from_site) as SiteConfig;
  if (here) {
    setTransfer(n, t, "assigned", v.id);
    startHandling(n, put(n, v, { transfer_id: t.id, intent: "load" }));
    return;
  }
  let target: string | null;
  let node: string;
  let intent: Intent;
  if (isPrimary(n, origin.id)) {
    target = freeStand(n, origin.id, "staging");
    node = origin.gate_node;
    intent = "enter_dc";
  } else {
    target = freeDoor(n, origin.id, "outbound") ?? freeStand(n, origin.id, "staging");
    node = target ? approachOf(n, target) : "";
    intent = "load";
  }
  if (!target) return; // no room at the origin yet; the transfer stays planned
  holdStand(n, target, v.id);
  setTransfer(n, t, "assigned", v.id);
  if (v.stand_id) holdStand(n, v.stand_id, null);
  travel(n, put(n, v, { transfer_id: t.id }), node, intent, target);
}

function idleSystem(n: NetworkDraft): void {
  const depot = n.config.sites.find((s) => s.kind === "fleet_depot");
  for (const v of n.vehicles.sorted()) {
    if (!isIdle(v)) continue;
    if (serviceDue(n, v) && depot) {
      if (v.stand_id && standKind(n, v.stand_id) === "service") continue;
      const bay = freeStand(n, depot.id, "service");
      if (bay) {
        holdStand(n, bay, v.id);
        if (v.stand_id) holdStand(n, v.stand_id, null);
        travel(n, v, approachOf(n, bay), "service", bay);
        continue;
      }
    }
    const home = (n.config.vehicles.find((c) => c.id === v.id) as { home_stand: string })
      .home_stand;
    if (v.stand_id === home) continue;
    holdStand(n, home, v.id);
    if (v.stand_id) holdStand(n, v.stand_id, null);
    travel(n, v, approachOf(n, home), "park", home);
  }
}
