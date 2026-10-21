import { DomainEvent, type SimulationCommand } from "@warehouse-one/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkInvariants,
  createInitialState,
  createNetworkScenario,
  createShowcaseScenario,
  createSnapshot,
  linehaulPose,
  loadSnapshot,
  replay,
  roadGraph,
  serializeSnapshot,
  stateHash,
  step,
  truckPose,
  validateConfig,
  type LoggedCommand,
  type SimulationConfig,
  type SimulationState,
} from "../index";
import { cargoTotal, HEADWAY_MM, type NetworkConfig } from "./model";

const scenario = createNetworkScenario();
const config = scenario.config;
const net = config.network as NetworkConfig;
const TICKS = 24_000;

function open(c: SimulationConfig = config) {
  return step(c, createInitialState(c), scenario.openingCommands).state;
}

/** Pallets in the modelled world: site stock, trailers on the network and every DC pallet. */
function worldPallets(s: SimulationState): number {
  const n = s.network;
  if (!n) return 0;
  let total = Object.keys(s.ops?.pallets ?? {}).length;
  for (const site of Object.values(n.sites)) for (const q of Object.values(site.stock)) total += q;
  for (const v of Object.values(n.vehicles)) total += cargoTotal(v.cargo);
  return total;
}

interface Run {
  events: DomainEvent[];
  final: SimulationState;
  maxJump: number;
  headwayViolations: string[];
  conservation: string[];
  handover: string[];
  holdDocked: string[];
}

let run: Run;

beforeAll(() => {
  let s = open();
  const events: DomainEvent[] = [];
  let maxJump = 0;
  const headwayViolations: string[] = [];
  const conservation: string[] = [];
  const handover: string[] = [];
  const holdDocked: string[] = [];
  let devanned = 0;
  let exported = 0;
  const base = worldPallets(s);
  for (let i = 0; i < TICKS; i++) {
    const prev = s;
    const r = step(config, s);
    s = r.state;
    for (const e of r.events) {
      events.push(e);
      if (
        e.event_type === "site.stock_changed" &&
        e.payload.reason === "devanned" &&
        e.payload.unit === "pallet"
      )
        devanned += e.payload.delta;
      if (
        e.event_type === "transfer.status_changed" &&
        e.payload.to === "delivered" &&
        e.payload.to_site_id === "east-gateway"
      )
        exported += cargoTotal(e.payload.lines);
    }
    const n = s.network!;
    // Poses move continuously (no teleports) while a truck is drawn by the network.
    for (const v of Object.values(n.vehicles)) {
      const before = prev.network!.vehicles[v.id]!;
      const a = linehaulPose(config, prev, before);
      const b = linehaulPose(config, s, v);
      if (a && b) maxJump = Math.max(maxJump, Math.hypot(a.x - b.x, a.z - b.z));
      // Hand-over: when the DC truck's hold ends it appears exactly where the line-haul truck was.
      if (before.status === "at_dc" && v.status === "at_dc" && a && !b) {
        const t = s.ops!.trucks[v.dc_truck_id!]!;
        const p = truckPose(config, t)!;
        const d = Math.hypot(p.x - a.x, p.z - a.z);
        if (d > 1.5) handover.push(`${v.id} jumped ${d.toFixed(2)} m at tick ${s.tick}`);
      }
    }
    // Same-direction trucks on one road segment keep the headway.
    const driving = Object.values(n.vehicles).filter((v) => v.status === "driving" && v.route[0]);
    for (const a of driving)
      for (const b of driving)
        // A truck still at the node (progress 0) has not entered the segment yet.
        if (
          a.id < b.id &&
          a.node === b.node &&
          a.route[0] === b.route[0] &&
          a.progress_mm > 0 &&
          b.progress_mm > 0
        ) {
          const gap = Math.abs(a.progress_mm - b.progress_mm);
          if (gap < HEADWAY_MM - 1)
            headwayViolations.push(`${a.id}/${b.id} ${gap} mm at ${s.tick}`);
        }
    for (const t of Object.values(s.ops!.trucks))
      if (t.hold_ticks_left !== undefined && t.status !== "yard")
        holdDocked.push(`${t.id} at ${s.tick}`);
    if (i % 250 === 0) {
      const w = worldPallets(s);
      if (w !== base + devanned - exported)
        conservation.push(`tick ${s.tick}: ${w} != ${base} + ${devanned} - ${exported}`);
      const v = checkInvariants(config, s);
      if (v.length) throw new Error(`tick ${s.tick}: ${v.join("; ")}`);
    }
  }
  run = { events, final: s, maxJump, headwayViolations, conservation, handover, holdDocked };
}, 120_000);

describe("network config: sites, identity and roads", () => {
  it("is valid and names every site with a stable id", () => {
    expect(validateConfig(config)).toEqual([]);
    expect(net.sites.map((s) => [s.id, s.kind])).toEqual([
      ["northgate-dc", "distribution_center"],
      ["harbour-terminal", "container_terminal"],
      ["riverside-xd", "cross_dock"],
      ["fleet-depot", "fleet_depot"],
      ["east-gateway", "gateway"],
    ]);
    expect(createNetworkScenario().config).toEqual(config);
  });

  it("connects every gate and stand to every other one by road", () => {
    const g = roadGraph(config);
    const points = [
      ...net.sites.map((s) => s.gate_node),
      ...net.sites.flatMap((s) => s.stands.map((x) => x.approach_node)),
    ];
    for (const a of points)
      for (const b of points) expect(g.route(a, b), `${a} -> ${b}`).not.toBeNull();
  });

  it("routes deterministically along the shortest path", () => {
    const g = roadGraph(config);
    const route = g.route("term-gate", "xd-gate");
    expect(route).toEqual(["depot-gate", "dc-gate", "dc-my-j", "xd-gate"]);
    const len = (r: readonly string[], from: string) => {
      let d = 0;
      let at = from;
      for (const n of r) {
        d += g.lengths.get(at < n ? `${at}|${n}` : `${n}|${at}`)!;
        at = n;
      }
      return d;
    };
    expect(len(route!, "term-gate")).toBe(g.distance("term-gate", "xd-gate"));
    // Symmetric roads give symmetric distances.
    expect(g.distance("xd-gate", "term-gate")).toBe(g.distance("term-gate", "xd-gate"));
  });

  it("keeps stands, buildings and sites from overlapping each other", () => {
    const boxes = net.sites.map((s) => ({ id: s.id, ...s.bounds }));
    for (const a of boxes)
      for (const b of boxes)
        if (a.id < b.id) {
          const overlap =
            a.min.x < b.max.x && b.min.x < a.max.x && a.min.z < b.max.z && b.min.z < a.max.z;
          expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
        }
    // Trucks standing at neighbouring stands never intersect (2.6 m wide, 16.5 m long).
    const stands = net.sites.flatMap((s) => s.stands);
    const unique = new Map(stands.map((s) => [`${s.position.x},${s.position.z}`, s]));
    expect(unique.size).toBe(stands.length);
    for (const a of stands)
      for (const b of stands) {
        if (a.id >= b.id) continue;
        const along = Math.abs(Math.cos(a.yaw)) > 0.5; // truck runs along z
        const dx = Math.abs(a.position.x - b.position.x);
        const dz = Math.abs(a.position.z - b.position.z);
        const clear = along ? dx >= 2.7 || dz >= 16.6 : dz >= 2.7 || dx >= 16.6;
        expect(clear, `${a.id} and ${b.id} overlap`).toBe(true);
      }
    // Every stand lies inside its site, every building inside its site.
    for (const s of net.sites) {
      const inside = (p: { x: number; z: number }) =>
        p.x >= s.bounds.min.x &&
        p.x <= s.bounds.max.x &&
        p.z >= s.bounds.min.z &&
        p.z <= s.bounds.max.z;
      for (const st of s.stands) expect(inside(st.position), st.id).toBe(true);
      for (const b of s.buildings) expect(inside(b.min) && inside(b.max), b.id).toBe(true);
    }
  });

  it("rejects broken networks with explicit problems", () => {
    const bad = (patch: Partial<NetworkConfig>) =>
      validateConfig({ ...config, network: { ...net, ...patch } });
    expect(bad({ primary_site: "nowhere" })).toContain("primary site 'nowhere' is not defined");
    expect(
      bad({
        nodes: [...net.nodes, { id: "island", position: { x: 999, z: 999 } }],
        sites: net.sites.map((s) => (s.id === "east-gateway" ? { ...s, gate_node: "island" } : s)),
      }),
    ).toContain("road node 'island' is not connected to the rest of the network");
    expect(bad({ lanes: [{ ...net.lanes[0]!, id: "lane-x", to_site: "fleet-depot" }] })).toContain(
      "lane 'lane-x' cannot end at a fleet depot",
    );
    expect(
      bad({ vehicles: [...net.vehicles, { id: "lh-99", label: "x", home_stand: "xd-in-01" }] }),
    ).toContain("truck 'lh-99' home must be a parking stand at a fleet depot");
    expect(validateConfig({ ...config, facility: undefined })).toContain(
      "network requires facility data (its primary site)",
    );
  });
});

describe("network simulation", () => {
  it("is deterministic and replays from its command log", () => {
    let a = open();
    let b = open();
    for (let i = 0; i < 3000; i++) {
      a = step(config, a).state;
      b = step(config, b).state;
    }
    expect(stateHash(config, a)).toBe(stateHash(config, b));
    const log: LoggedCommand[] = scenario.openingCommands.map((command) => ({ tick: 1, command }));
    expect(stateHash(config, replay(config, log, a.tick))).toBe(stateHash(config, a));
  });

  it("emits only events that satisfy the published contract (the API and pipeline accept them)", () => {
    const types = new Set<string>();
    for (const e of run.events) {
      const r = DomainEvent.safeParse(e);
      if (!r.success) throw new Error(`${e.event_type}: ${r.error.issues[0]?.message}`);
      types.add(e.event_type);
    }
    for (const t of ["transfer.status_changed", "linehaul.status_changed", "site.stock_changed"])
      expect(types).toContain(t);
    // Sequence is gap-free across the DC's and the network's events.
    run.events.forEach((e, i) => {
      if (i > 0) expect(e.sequence).toBe(run.events[i - 1]!.sequence + 1);
    });
  });

  it("keeps every pallet accounted for across sites, trailers and the DC", () => {
    expect(run.conservation).toEqual([]);
  });

  it("drives trucks between sites without teleporting and with a safe headway", () => {
    expect(run.maxJump).toBeLessThan(4.5);
    expect(run.headwayViolations).toEqual([]);
    const driven = Object.values(run.final.network!.vehicles).map((v) => v.odometer_mm);
    for (const d of driven) expect(d).toBeGreaterThan(2_000_000); // every truck drove > 2 km
  });

  it("moves transfers through their lifecycle in order, on every lane", () => {
    const history = new Map<string, string[]>();
    const lanes = new Set<string>();
    for (const e of run.events) {
      if (e.event_type !== "transfer.status_changed") continue;
      const h = history.get(e.payload.transfer_id) ?? [];
      expect(e.payload.from).toBe(h.at(-1) ?? null);
      h.push(e.payload.to);
      history.set(e.payload.transfer_id, h);
      if (e.payload.lane_id) lanes.add(e.payload.lane_id);
    }
    expect([...lanes].sort()).toEqual(net.lanes.map((l) => l.id).sort());
    const done = [...history.values()].filter((h) => h.at(-1) === "delivered");
    expect(done.length).toBeGreaterThan(30);
    for (const h of done) {
      const viaGateway = !h.includes("unloading");
      expect(h).toEqual(
        viaGateway
          ? ["planned", "assigned", "loading", "in_transit", "delivered"]
          : ["planned", "assigned", "loading", "in_transit", "unloading", "delivered"],
      );
    }
  });

  it("hands trucks to the DC simulation and back without a visible jump", () => {
    const toDc = run.events.filter(
      (e) =>
        e.event_type === "transfer.status_changed" &&
        e.payload.to_site_id === "northgate-dc" &&
        e.payload.to === "delivered",
    );
    const fromDc = run.events.filter(
      (e) =>
        e.event_type === "transfer.status_changed" &&
        e.payload.from_site_id === "northgate-dc" &&
        e.payload.to === "in_transit",
    );
    expect(toDc.length).toBeGreaterThan(2);
    expect(fromDc.length).toBeGreaterThan(2);
    // Every DC truck of a transfer carries its correlation id (traceable end to end).
    for (const e of toDc) {
      const corr = e.correlation_id;
      const inbound = run.events.filter(
        (x) =>
          x.event_type === "pallet.created" &&
          x.correlation_id === corr &&
          x.payload.cause === "inbound_truck",
      );
      expect(inbound.length).toBe(
        e.event_type === "transfer.status_changed" ? cargoTotal(e.payload.lines) : 0,
      );
    }
    expect(run.handover).toEqual([]);
    expect(run.holdDocked).toEqual([]);
  });

  it("stacks containers from vessel calls and devans them into pallets", () => {
    const reasons = new Set(
      run.events.flatMap((e) =>
        e.event_type === "site.stock_changed" ? [`${e.payload.unit}:${e.payload.reason}`] : [],
      ),
    );
    expect([...reasons].sort()).toEqual([
      "container:devanned",
      "container:vessel_discharge",
      "pallet:devanned",
      "pallet:loaded",
      "pallet:unloaded",
    ]);
  });

  it("services trucks at the depot after the service interval", () => {
    const serviced = run.events.filter(
      (e) => e.event_type === "linehaul.status_changed" && e.payload.to === "servicing",
    );
    expect(serviced.length).toBeGreaterThan(0);
    for (const e of serviced)
      if (e.event_type === "linehaul.status_changed") expect(e.payload.site_id).toBe("fleet-depot");
  });

  it("snapshots and restores network state", () => {
    const snap = loadSnapshot(serializeSnapshot(createSnapshot(config, run.final)));
    expect(snap.state).toEqual(run.final);
  });
});

describe("operator transfer requests", () => {
  const request = (payload: object, id = "op-1"): SimulationCommand =>
    ({ command_id: id, type: "transfer.request", payload }) as SimulationCommand;

  it("plans a transfer and reserves stock at the origin and room at the destination", () => {
    const s = open();
    const r = step(config, s, [
      request({
        from_site_id: "riverside-xd",
        to_site_id: "harbour-terminal",
        lines: [{ sku: "sku-cold-chain", quantity: 5 }],
      }),
    ]);
    expect(r.rejections).toEqual([]);
    const planned = r.events.find(
      (e) => e.event_type === "transfer.status_changed" && e.correlation_id === "op-1",
    );
    expect(planned?.event_type === "transfer.status_changed" && planned.payload.lane_id).toBeNull();
    const n = r.state.network!;
    expect(n.sites["riverside-xd"]!.allocated["sku-cold-chain"]).toBe(5);
    expect(n.sites["harbour-terminal"]!.incoming).toBe(5);
    expect(checkInvariants(config, r.state)).toEqual([]);
  });

  it.each([
    [{ from_site_id: "atlantis", to_site_id: "riverside-xd" }, "UNKNOWN_SITE"],
    [{ from_site_id: "fleet-depot", to_site_id: "riverside-xd" }, "INVALID_TRANSFER"],
    [{ from_site_id: "east-gateway", to_site_id: "riverside-xd" }, "INVALID_TRANSFER"],
    [{ from_site_id: "riverside-xd", to_site_id: "fleet-depot" }, "INVALID_TRANSFER"],
  ])("rejects %o with %s", (sites, code) => {
    const r = step(config, open(), [
      request({ ...sites, lines: [{ sku: "sku-cold-chain", quantity: 1 }] }),
    ]);
    expect(r.rejections.map((x) => x.code)).toEqual([code]);
  });

  it("rejects transfers the origin cannot supply or the destination cannot hold", () => {
    const s = open();
    const short = step(config, s, [
      request({
        from_site_id: "riverside-xd",
        to_site_id: "northgate-dc",
        lines: [{ sku: "sku-cold-chain", quantity: 17 }],
      }),
    ]);
    expect(short.rejections.map((x) => x.code)).toEqual(["INSUFFICIENT_STOCK"]);
    // A cross-dock with room for only 5 more pallets.
    const small: SimulationConfig = {
      ...config,
      network: {
        ...net,
        sites: net.sites.map((x) => (x.id === "riverside-xd" ? { ...x, pallet_capacity: 65 } : x)),
      },
    };
    expect(validateConfig(small)).toEqual([]);
    const full = step(small, open(small), [
      request({
        from_site_id: "harbour-terminal",
        to_site_id: "riverside-xd",
        lines: [{ sku: "sku-std-pallet", quantity: 6 }],
      }),
    ]);
    expect(full.rejections.map((x) => x.code)).toEqual(["NO_CAPACITY"]);
    // A single-site scenario has no network.
    const single = createShowcaseScenario();
    const r = step(single.config, createInitialState(single.config), [
      request({
        from_site_id: "riverside-xd",
        to_site_id: "harbour-terminal",
        lines: [{ sku: "sku-cold-chain", quantity: 1 }],
      }),
    ]);
    expect(r.rejections.map((x) => x.code)).toEqual(["NETWORK_DISABLED"]);
  });

  it("does not let an operator cancel a DC order that loads a line-haul truck", () => {
    let s = open();
    let order: string | undefined;
    for (let i = 0; i < 6000 && !order; i++) {
      const r = step(config, s);
      s = r.state;
      const created = r.events.find(
        (e) =>
          e.event_type === "order.status_changed" &&
          e.payload.to === "open" &&
          e.causation_id === "system:network",
      );
      if (created?.event_type === "order.status_changed") order = created.payload.order_id;
    }
    expect(order).toBeDefined();
    const r = step(config, s, [
      { command_id: "op-cancel", type: "order.cancel", payload: { order_id: order! } },
    ]);
    expect(r.rejections.map((x) => x.code)).toEqual(["ORDER_NOT_CANCELLABLE"]);
  });
});

describe("backward compatibility", () => {
  it("single-site scenarios keep the Phase 2 state shape", () => {
    const s = createShowcaseScenario();
    const state = step(s.config, createInitialState(s.config), s.openingCommands).state;
    expect(state.network).toBeUndefined();
    expect("network" in state).toBe(false);
    for (const t of Object.values(state.ops!.trucks)) expect("hold_ticks_left" in t).toBe(false);
  });
});
