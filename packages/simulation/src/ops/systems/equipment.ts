import type { PalletPosition } from "@warehouse-one/contracts";
import type { OpsDraft } from "../ops-draft";
import {
  BATTERY_CHARGED,
  BATTERY_DRAIN_MM,
  BATTERY_DRAIN_PER_HANDLING,
  BATTERY_NEEDS_CHARGE,
  CHARGE_TICKS_PER_PERMILLE,
  HANDLING_BASE_TICKS,
  HANDLING_TICKS_PER_LEVEL,
  positionKey,
  SPEED_MM_PER_TICK,
  WAIT_REPLAN_TICKS,
  type EquipmentState,
  type Heading,
  type HandlingState,
} from "../model";
import { findPath, headingBetween, pathLength } from "../nav";
import { nodeFor } from "../tasks";
import { setEquipment } from "./equipment-events";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Moves, handles and charges every vehicle by exactly one tick, in equipment-id order.
 *
 * Traffic rules (deterministic, no teleporting):
 * - A vehicle holds the node it is on and, while on an edge, the node it is driving to. It may only
 *   enter a node no other vehicle holds; otherwise it waits.
 * - Dock paths and the charging road are exclusive zones. A vehicle claims the zone before stepping
 *   onto the node in front of it, so a waiting vehicle never blocks the zone's exit.
 * - After WAIT_REPLAN_TICKS of waiting, the vehicle replans around the blocking node (and again
 *   every WAIT_REPLAN_TICKS). If no alternative exists it keeps waiting; it never jumps.
 */
export function equipmentSystem(o: OpsDraft): void {
  const traffic = new Traffic(o);
  for (const id of o.equipment.sorted().map((e) => e.id)) {
    const e = o.equipment.get(id) as EquipmentState;
    switch (e.status) {
      case "travelling":
        travel(o, traffic, e);
        break;
      case "handling":
        handle(o, e);
        break;
      case "charging":
        charge(o, e);
        break;
      case "idle":
        idle(o, e);
        break;
    }
  }
}

class Traffic {
  private readonly holders = new Map<string, string>();
  private readonly claims = new Map<string, string>();
  constructor(private readonly o: OpsDraft) {
    for (const e of o.equipment.values()) this.register(e);
  }
  register(e: EquipmentState): void {
    for (const [n, id] of [...this.holders]) if (id === e.id) this.holders.delete(n);
    for (const [z, id] of [...this.claims]) if (id === e.id) this.claims.delete(z);
    this.holders.set(e.node, e.id);
    if (e.progress_mm > 0 && e.route[0]) this.holders.set(e.route[0], e.id);
    if (e.zone_claim) this.claims.set(e.zone_claim, e.id);
  }
  /** The vehicle blocking `id` from entering `next` (route continues with `after`), if any. */
  blocker(id: string, next: string, after: string | undefined, claim: string | null): { by: string; zone: string | null } | null {
    const holder = this.holders.get(next);
    if (holder && holder !== id) return { by: holder, zone: null };
    const zone = this.zoneNeeded(next, after);
    if (zone && zone !== claim) {
      const owner = this.claims.get(zone);
      if (owner && owner !== id) return { by: owner, zone };
    }
    return null;
  }
  isHeld(node: string): boolean {
    return this.holders.has(node);
  }
  zoneNeeded(next: string, after: string | undefined): string | null {
    const zn = this.o.graph.nodes.get(next)?.zone ?? null;
    if (zn) return zn;
    return after ? (this.o.graph.nodes.get(after)?.zone ?? null) : null;
  }
}

/**
 * Wait resolution for a vehicle that has waited WAIT_REPLAN_TICKS (deterministic):
 * - Waiting for a zone, or behind a vehicle that is handling or moving: keep waiting (it clears).
 * - Behind a vehicle that is itself stuck: follow the wait-for chain. If it loops back (a true
 *   deadlock), the highest-id vehicle in the cycle that has a free neighbouring node backs off to
 *   it and carries on from there. Otherwise route around the blocker if the detour is reasonable
 *   (at most twice the remaining distance plus 30 m).
 */
function resolveWait(
  o: OpsDraft,
  traffic: Traffic,
  e: Mutable<EquipmentState> & { route: string[] },
  next: string,
  block: { by: string; zone: string | null },
): void {
  if (block.zone) return;
  const g = o.graph;
  const stuck = (v: EquipmentState) => v.status === "travelling" && v.progress_mm === 0 && v.wait_ticks > 0 && v.blocked_by !== null;
  const other = o.equipment.get(block.by);
  if (!other || !stuck(other)) return;
  const target = e.route[e.route.length - 1] as string;

  const cycle: EquipmentState[] = [e];
  let cur: EquipmentState | undefined = other;
  let closed = false;
  for (let k = 0; k < 8 && cur; k++) {
    if (cur.id === e.id) {
      closed = true;
      break;
    }
    if (!stuck(cur) || cycle.some((c) => c.id === cur!.id)) break;
    cycle.push(cur);
    cur = o.equipment.get(cur.blocked_by as string);
  }

  const sides = (v: EquipmentState) => {
    const blocker = v.id === e.id ? other.node : o.equipment.get(v.blocked_by as string)?.node;
    return (g.adjacency.get(v.node) ?? [])
      .map((x) => x.to)
      .filter((m) => m !== blocker && !traffic.isHeld(m) && (!g.nodes.get(m)?.zone || g.nodes.get(m)?.zone === v.zone_claim));
  };

  if (closed) {
    const victim = cycle
      .filter((v) => sides(v).length > 0)
      .sort((a, b) => b.id.localeCompare(a.id))[0];
    const side = victim?.id === e.id ? sides(e)[0] : undefined;
    if (side) {
      e.route = [side, ...(findPath(g, side, target) ?? [])];
      e.wait_ticks = 0;
    }
    return;
  }

  if (next === target) return;
  const remaining = pathLength(g, e.node, e.route);
  const around = findPath(g, e.node, target, new Set([next]));
  if (around && around.length > 0 && pathLength(g, e.node, around) <= remaining * 2 + 30000) e.route = around;
}

function travel(o: OpsDraft, traffic: Traffic, start: EquipmentState): void {
  const g = o.graph;
  const e: Mutable<EquipmentState> & { route: string[] } = { ...start, route: [...start.route] };
  const loaded = e.carrying !== null;
  let remaining = SPEED_MM_PER_TICK[e.kind][loaded ? "loaded" : "empty"];

  while (remaining > 0 && e.route.length > 0) {
    const next = e.route[0] as string;
    if (e.progress_mm === 0) {
      const block = traffic.blocker(e.id, next, e.route[1], e.zone_claim);
      if (block) {
        e.wait_ticks += 1;
        e.blocked_by = block.by;
        if (e.wait_ticks % WAIT_REPLAN_TICKS === 0) resolveWait(o, traffic, e, next, block);
        break;
      }
      const zone = traffic.zoneNeeded(next, e.route[1]);
      if (zone) e.zone_claim = zone;
    }
    const length = g.adjacency.get(e.node)?.find((x) => x.to === next)?.length;
    if (length === undefined) throw new Error(`invariant violated: ${e.id} route ${e.node}→${next} is not an edge`);
    const step = Math.min(remaining, length - e.progress_mm);
    e.progress_mm += step;
    remaining -= step;
    e.odometer_mm += step;
    e.drain_mm += step;
    e.heading = headingBetween(g.nodes.get(e.node)!, g.nodes.get(next)!);
    e.wait_ticks = 0;
    e.blocked_by = null;
    if (e.progress_mm === length) {
      e.node = next;
      e.route.shift();
      e.progress_mm = 0;
      // Release the zone once neither this node nor the next one is inside it.
      if (e.zone_claim && g.nodes.get(e.node)?.zone !== e.zone_claim && traffic.zoneNeeded(e.route[0] ?? e.node, e.route[1]) !== e.zone_claim) {
        e.zone_claim = null;
      }
    }
    traffic.register(e);
  }
  while (e.drain_mm >= BATTERY_DRAIN_MM) {
    e.drain_mm -= BATTERY_DRAIN_MM;
    e.battery_permille = Math.max(0, e.battery_permille - 1);
  }
  traffic.register(e);
  if (e.route.length === 0 && e.progress_mm === 0) arrive(o, start, e);
  else setEquipment(o, start, e);
}

/** Lift height (mm) and the direction to face for handling at a position. */
function handlingGeometry(o: OpsDraft, p: PalletPosition): { lift: number; facing: Heading; level: number } {
  const f = o.draft.config.facility!;
  if (p.kind === "slot") {
    const loc = o.draft.locationIndex.get(p.location_id)!;
    const level = Math.floor(p.slot / f.rack.positions_per_level);
    // The aisle lies on the pick-face side; the vehicle faces back towards the rack.
    const facesPlusZ = Math.abs(loc.yaw ?? 0) < 1e-6;
    return { lift: Math.round(level * f.rack.level_height * 1000), facing: facesPlusZ ? "nz" : "pz", level };
  }
  if (p.kind === "staging") return { lift: 0, facing: "px", level: 0 };
  return { lift: 0, facing: "pz", level: 0 };
}

function startHandling(o: OpsDraft, start: EquipmentState, e: Mutable<EquipmentState>, at: PalletPosition): void {
  const { lift, facing, level } = handlingGeometry(o, at);
  const ticks = 2 * Math.ceil((HANDLING_BASE_TICKS + level * HANDLING_TICKS_PER_LEVEL) / 2);
  const handling: HandlingState = { ticks_total: ticks, ticks_left: ticks, transferred: false, lift_mm: lift, facing };
  setEquipment(o, start, { ...e, status: "handling", handling, heading: facing });
}

function arrive(o: OpsDraft, start: EquipmentState, e: Mutable<EquipmentState>): void {
  if (e.purpose === "task" && e.task_id) {
    const task = o.tasks.get(e.task_id)!;
    if (task.status === "assigned") {
      o.tasks.set(task.id, { ...task, status: "picking" });
      startHandling(o, start, e, task.from);
    } else if (task.status === "carrying") {
      o.tasks.set(task.id, { ...task, status: "dropping" });
      startHandling(o, start, e, task.to);
    } else {
      throw new Error(`invariant violated: ${e.id} arrived for task ${task.id} in status ${task.status}`);
    }
    return;
  }
  if (e.purpose === "charge") return setEquipment(o, start, { ...e, status: "charging" });
  // Parked at home: opportunity-charge until full.
  const atHome = e.node === o.graph.chargerNode.get(e.id);
  setEquipment(o, start, { ...e, status: atHome && e.battery_permille < BATTERY_CHARGED ? "charging" : "idle", purpose: null });
}

function handle(o: OpsDraft, start: EquipmentState): void {
  const h = start.handling!;
  const task = o.tasks.get(start.task_id ?? "")!;
  const e: Mutable<EquipmentState> = { ...start };
  const left = h.ticks_left - 1;
  let transferred = h.transferred;
  if (!transferred && left <= h.ticks_total / 2) {
    transferred = true;
    const pallet = o.pallets.get(task.pallet_id)!;
    const trace = { correlation_id: task.correlation_id, causation_id: `system:equipment` };
    if (task.status === "picking") {
      const at: PalletPosition = { kind: "equipment", equipment_id: e.id };
      o.placePallet({ ...pallet, at }, pallet);
      e.carrying = pallet.id;
      o.draft.emit("pallet.moved", pallet.id, { pallet_id: pallet.id, sku: pallet.sku, from: pallet.at, to: at, task_id: task.id }, trace);
    } else {
      o.reservations.delete(positionKey(task.to));
      o.placePallet({ ...pallet, at: task.to }, pallet);
      e.carrying = null;
      o.draft.emit("pallet.moved", pallet.id, { pallet_id: pallet.id, sku: pallet.sku, from: pallet.at, to: task.to, task_id: task.id }, trace);
    }
    e.battery_permille = Math.max(0, e.battery_permille - BATTERY_DRAIN_PER_HANDLING);
  }
  if (left > 0) {
    setEquipment(o, start, { ...e, handling: { ...h, ticks_left: left, transferred } });
    return;
  }
  if (task.status === "picking") {
    const drop = nodeFor(o, task.to);
    if (!drop) throw new Error(`invariant violated: task ${task.id} destination has no node`);
    const route = findPath(o.graph, e.node, drop);
    if (!route) throw new Error(`invariant violated: no route from ${e.node} to ${drop}`);
    o.tasks.set(task.id, { ...task, status: "carrying" });
    setEquipment(o, start, { ...e, status: "travelling", handling: null, route, progress_mm: 0, wait_ticks: 0, blocked_by: null });
    return;
  }
  // Drop finished: the task is complete.
  o.tasks.delete(task.id);
  o.updatePallet(task.pallet_id, { task_id: null });
  o.draft.emit(
    "task.completed",
    task.id,
    { task_id: task.id, equipment_id: e.id, duration_ticks: o.tick - task.created_tick },
    { correlation_id: task.correlation_id, causation_id: "system:equipment" },
  );
  setEquipment(o, start, { ...e, status: "idle", handling: null, task_id: null, purpose: null });
}

function charge(o: OpsDraft, start: EquipmentState): void {
  const battery = o.tick % CHARGE_TICKS_PER_PERMILLE === 0 ? Math.min(1000, start.battery_permille + 1) : start.battery_permille;
  if (battery >= BATTERY_CHARGED) setEquipment(o, start, { ...start, battery_permille: battery, status: "idle", purpose: null });
  else setEquipment(o, start, { ...start, battery_permille: battery });
}

/** Idle vehicles go home: to charge when low, otherwise to park (and top up there). */
function idle(o: OpsDraft, start: EquipmentState): void {
  const home = o.graph.chargerNode.get(start.id)!;
  const low = start.battery_permille < BATTERY_NEEDS_CHARGE;
  if (start.node === home) {
    if (start.battery_permille < BATTERY_CHARGED) setEquipment(o, start, { ...start, status: "charging", purpose: low ? "charge" : null });
    return;
  }
  const route = findPath(o.graph, start.node, home);
  if (!route) throw new Error(`invariant violated: ${start.id} cannot reach its charger`);
  setEquipment(o, start, { ...start, status: "travelling", purpose: low ? "charge" : "park", route, progress_mm: 0, wait_ticks: 0, blocked_by: null });
}
