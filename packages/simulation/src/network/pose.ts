import { must } from "../ops/must";
import { TRUCK_LENGTH, yardPose, type Pose } from "../ops/pose";
import type { SimulationConfig, SimulationState } from "../types";
import { networkIndex } from "./draft";
import {
  DC_ENTER_TICKS,
  DC_LEAVE_TICKS,
  DOCK_TICKS,
  UNDOCK_TICKS,
  type LinehaulState,
} from "./model";

/**
 * Where a line-haul truck is, in metres and radians, derived from its state (renderers and tests
 * read this; nothing here feeds back into the simulation). Trucks keep right: on a road they are
 * offset from the centre line by LANE_OFFSET. Returns null while the truck is drawn as the DC's own
 * truck (at_dc after its arrival manoeuvre) or is outside the modelled world.
 */
export const LANE_OFFSET = 1.9;

type P = { x: number; z: number };

const headingYaw = (a: P, b: P) => Math.atan2(b.x - a.x, b.z - a.z);
const forward = (yaw: number): P => ({ x: Math.sin(yaw), z: Math.cos(yaw) });
/** Right-hand side of a heading (x east, z south, y up). */
const right = (yaw: number): P => ({ x: -Math.cos(yaw), z: Math.sin(yaw) });
const ease = (t: number) => t * t * (3 - 2 * t);

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function lane(p: P, yaw: number): P {
  const r = right(yaw);
  return { x: p.x + r.x * LANE_OFFSET, z: p.z + r.z * LANE_OFFSET };
}

/** Quadratic Bézier from `a` to `b` whose end tangent runs along `endDir` (or start tangent). */
function curve(a: P, c: P, b: P, t: number): P {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    z: u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  };
}

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.z - b.z);

/** Manoeuvre between a road point (with heading) and a standing pose, reversing into the stand. */
function manoeuvre(road: Pose, stand: Pose, p: number, into: boolean): Pose {
  const f = forward(stand.yaw);
  const k = Math.min(dist(road, stand) * 0.65, TRUCK_LENGTH * 1.4);
  const ctrl = { x: stand.x + f.x * k, z: stand.z + f.z * k };
  const t = ease(p);
  if (into) {
    const pos = curve(road, ctrl, stand, t);
    return { ...pos, yaw: lerpAngle(road.yaw, stand.yaw, ease(Math.min(1, p * 1.4))) };
  }
  const pos = curve(stand, ctrl, road, t);
  return { ...pos, yaw: lerpAngle(stand.yaw, road.yaw, ease(Math.max(0, p * 1.4 - 0.4))) };
}

export function linehaulPose(
  config: SimulationConfig,
  state: SimulationState,
  v: LinehaulState,
): Pose | null {
  const idx = networkIndex(config);
  const g = idx.graph;
  const node = (id: string) => must(g.nodes.get(id), `road node ${id}`);
  const standPose = (id: string): Pose => {
    const s = must(idx.stands.get(id), `stand ${id}`).stand;
    return { x: s.position.x, z: s.position.z, yaw: s.yaw };
  };
  /** The truck on the road at `at`, having come from `from` (keeps right). */
  const arriving = (at: string, from: string | null, fallbackYaw: number): Pose => {
    const p = node(at);
    const yaw = from ? headingYaw(node(from), p) : fallbackYaw;
    return { ...lane(p, yaw), yaw };
  };
  /** The truck on the road at `at`, about to drive towards `to`. */
  const leaving = (at: string, to: string | undefined, fallbackYaw: number): Pose => {
    const p = node(at);
    const yaw = to ? headingYaw(p, node(to)) : fallbackYaw;
    return { ...lane(p, yaw), yaw };
  };

  switch (v.status) {
    case "off_network":
      return null;
    case "driving": {
      const next = v.route[0];
      if (!next) return arriving(v.node, v.prev_node, 0);
      const a = node(v.node);
      const b = node(next);
      const len = dist(a, b);
      const t = len > 0 ? Math.min(1, v.progress_mm / 1000 / len) : 0;
      const yaw = headingYaw(a, b);
      return { ...lane({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, yaw), yaw };
    }
    case "docking": {
      const stand = standPose(must(v.stand_id, `stand of ${v.id}`));
      const road = arriving(v.node, v.prev_node, stand.yaw + Math.PI);
      return manoeuvre(road, stand, 1 - v.manoeuvre_ticks_left / DOCK_TICKS, true);
    }
    case "undocking": {
      if (v.stand_id) {
        const stand = standPose(v.stand_id);
        const road = leaving(v.node, v.route[0], stand.yaw);
        return manoeuvre(road, stand, 1 - v.manoeuvre_ticks_left / UNDOCK_TICKS, false);
      }
      // Leaving the DC: from where its truck left the yard, forward onto the road.
      const exit = dcExitPose(config, v.dc_dock_id);
      const road = leaving(v.node, nextNodeAfterDc(config, state, v), Math.PI / 2);
      const p = ease(1 - v.manoeuvre_ticks_left / DC_LEAVE_TICKS);
      const f = forward(exit.yaw);
      const k = Math.max(4, Math.abs(road.z - exit.z) * 0.8);
      const pos = curve(exit, { x: exit.x + f.x * k, z: exit.z + f.z * k }, road, p);
      return { ...pos, yaw: lerpAngle(exit.yaw, road.yaw, ease(Math.max(0, p * 1.3 - 0.3))) };
    }
    case "at_dc": {
      const truck = state.ops?.trucks[v.dc_truck_id ?? ""];
      const hold = truck?.hold_ticks_left;
      if (hold === undefined || v.dc_yard_slot === null) return null;
      const road = arriving(v.node, v.prev_node, Math.PI);
      const slot = yardPose(config, v.dc_yard_slot);
      return manoeuvre(road, slot, 1 - hold / DC_ENTER_TICKS, true);
    }
    case "waiting":
    case "parked":
    case "loading":
    case "unloading":
    case "servicing":
      return v.stand_id ? standPose(v.stand_id) : arriving(v.node, v.prev_node, 0);
  }
}

/** Where the DC's truck left the site: straight out from its dock, as `truckPose` draws it. */
function dcExitPose(config: SimulationConfig, dockId: string | null): Pose {
  const f = must(config.facility, "facility");
  const dock = f.docks.find((d) => d.id === dockId) ?? f.docks[0];
  return { x: dock?.position.x ?? 0, z: f.site.max.z + TRUCK_LENGTH, yaw: 0 };
}

/** First road node the truck will take after leaving the DC (towards its destination or home). */
function nextNodeAfterDc(
  config: SimulationConfig,
  state: SimulationState,
  v: LinehaulState,
): string | undefined {
  const idx = networkIndex(config);
  const net = must(config.network, "network");
  const t = v.transfer_id ? state.network?.transfers[v.transfer_id] : undefined;
  let target: string | undefined;
  if (t) target = idx.sites.get(t.to_site)?.gate_node;
  else {
    const home = net.vehicles.find((x) => x.id === v.id)?.home_stand;
    target = home ? idx.stands.get(home)?.stand.approach_node : undefined;
  }
  return target ? idx.graph.route(v.node, target)?.[0] : undefined;
}
