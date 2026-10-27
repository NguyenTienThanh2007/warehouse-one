import { describe, expect, it } from "vitest";
import {
  checkInvariants,
  createInitialState,
  createNetworkScenario,
  createShowcaseScenario,
  replay,
  stateHash,
  step,
  type LoggedCommand,
  type SimulationConfig,
  type SimulationState,
} from "../index";
import { PARK_SITES } from "../scenarios/network";
import type { NetworkConfig } from "./model";
import { standbyCapacity, standbyProblem, standbySites } from "./standby";

const scenario = createNetworkScenario();
const config = scenario.config;
const net = config.network as NetworkConfig;
const open = (c: SimulationConfig = config) =>
  step(c, createInitialState(c), scenario.openingCommands).state;

const standby = (id: string, vehicle: string, site: string | null) => ({
  command_id: id,
  type: "linehaul.set_standby" as const,
  payload: { vehicle_id: vehicle, site_id: site },
});

function run(s: SimulationState, ticks: number): SimulationState {
  for (let i = 0; i < ticks; i++) {
    s = step(config, s).state;
  }
  return s;
}

describe("fleet standby rules", () => {
  it("allows staging-stall sites only, keeping one stall free", () => {
    expect(standbySites(net).map((s) => s.id)).toEqual([
      PARK_SITES.dc,
      PARK_SITES.terminal,
      PARK_SITES.crossDock,
    ]);
    expect(standbyCapacity(net, PARK_SITES.terminal)).toBe(3); // 4 stalls, 1 kept free
    expect(standbyProblem(net, PARK_SITES.depot)).toMatch(/home stall/);
    expect(standbyProblem(net, PARK_SITES.gateway)).toMatch(/no stalls/);
    expect(standbyProblem(net, "nowhere")).toMatch(/unknown site/);
  });

  it("validates the command and rejects with a code, changing nothing", () => {
    const s = open();
    const fleet = Object.keys(s.network?.vehicles ?? {}).sort();
    const r = step(config, s, [
      standby("a", "lh-nope", PARK_SITES.terminal),
      standby("b", fleet[0] as string, "nowhere"),
      standby("c", fleet[0] as string, PARK_SITES.depot),
      standby("d", fleet[0] as string, PARK_SITES.gateway),
      ...fleet.slice(0, 4).map((v, i) => standby(`t${i}`, v, PARK_SITES.terminal)),
    ]);
    expect(r.rejections.map((x) => [x.command_id, x.code])).toEqual([
      ["a", "UNKNOWN_VEHICLE"],
      ["b", "UNKNOWN_SITE"],
      ["c", "INVALID_STANDBY"],
      ["d", "INVALID_STANDBY"],
      ["t3", "INVALID_STANDBY"],
    ]);
    expect(r.rejections[4]?.message).toMatch(/at most 3 trucks/);
    const set = Object.values(r.state.network?.vehicles ?? {}).filter((v) => v.standby_site);
    expect(set.map((v) => v.id)).toEqual(fleet.slice(0, 3));
    expect(checkInvariants(config, r.state)).toEqual([]);
  });

  it("is rejected in a single-site scenario", () => {
    const show = createShowcaseScenario().config;
    const r = step(show, createInitialState(show), [standby("x", "lh-01", PARK_SITES.terminal)]);
    expect(r.rejections[0]?.code).toBe("NETWORK_DISABLED");
  });

  it("idle trucks wait on a free stall at their standby site; clearing sends them home", () => {
    let s = open();
    const fleet = Object.keys(s.network?.vehicles ?? {}).sort();
    const id = fleet.at(-1) as string;
    s = step(config, s, [standby("s", id, PARK_SITES.crossDock)]).state;
    // Wait until the truck is parked on a cross-dock staging stall (it may be busy first).
    let parkedAt: string | null = null;
    for (let i = 0; i < 12_000 && !parkedAt; i++) {
      s = step(config, s).state;
      const v = s.network?.vehicles[id];
      if (v?.status === "parked" && v.stand_id?.startsWith("xd-stall")) parkedAt = v.stand_id;
      expect(checkInvariants(config, s)).toEqual([]);
    }
    expect(parkedAt).not.toBeNull();
    expect(s.network?.sites[PARK_SITES.crossDock]?.stands[parkedAt as string]).toBe(id);

    s = step(config, s, [standby("c", id, null)]).state;
    expect(s.network?.vehicles[id]?.standby_site).toBeUndefined();
    let home = false;
    for (let i = 0; i < 6_000 && !home; i++) {
      s = step(config, s).state;
      const v = s.network?.vehicles[id];
      home = v?.status === "parked" && !!v.stand_id?.startsWith("depot-park");
    }
    expect(home).toBe(true);
  });

  it("never fills the last staging stall, and every rule holds over a long run", () => {
    let s = open();
    const fleet = Object.keys(s.network?.vehicles ?? {}).sort();
    s = step(
      config,
      s,
      fleet.map((v, i) => standby(`s${i}`, v, i < 3 ? PARK_SITES.terminal : PARK_SITES.crossDock)),
    ).state;
    const stalls = (site: string) =>
      net.sites
        .find((x) => x.id === site)
        ?.stands.filter((x) => x.kind === "staging")
        .map((x) => x.id) ?? [];
    for (let i = 0; i < 18_000; i++) {
      s = step(config, s).state;
      if (i % 250 === 0) expect(checkInvariants(config, s)).toEqual([]);
      for (const site of [PARK_SITES.terminal, PARK_SITES.crossDock]) {
        const parked = stalls(site).filter((id) => {
          const holder = s.network?.sites[site]?.stands[id];
          const v = holder ? s.network?.vehicles[holder] : undefined;
          return v?.status === "parked" && v.transfer_id === null;
        });
        expect(parked.length).toBeLessThan(stalls(site).length);
      }
    }
  }, 60_000);

  it("replays identically with standby commands in the log", () => {
    let s = open();
    const fleet = Object.keys(s.network?.vehicles ?? {}).sort();
    const log: LoggedCommand[] = scenario.openingCommands.map((command) => ({ tick: 1, command }));
    const cmds = [standby("r1", fleet[0] as string, PARK_SITES.terminal)];
    const r = step(config, s, cmds);
    s = r.state;
    for (const command of cmds) log.push({ tick: s.tick, command });
    s = run(s, 3_000);
    const replayed = replay(config, log, s.tick);
    expect(stateHash(config, replayed)).toBe(stateHash(config, s));
  });
});
