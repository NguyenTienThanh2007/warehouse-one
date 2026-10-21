import type { DomainEvent } from "@warehouse-one/contracts";
import { checkInvariants, replay } from "../engine";
import { deterministicUuid } from "../hash";
import { cargoTotal } from "../network/model";
import { stateHash } from "../snapshot";
import type { CommandRejection, LoggedCommand, SimulationConfig, SimulationState } from "../types";
import { createNetworkScenario } from "./warehouse";

/**
 * Logistics-network reference run (Phase 5): the network scenario's opening stock, its seeded
 * transfer lanes, one operator transfer request and two the rules must reject. Long enough for
 * trucks to complete trips between every kind of site, enter and leave the DC, and reach the
 * gateway. The fixture in `data/fixtures/network-demo` pins its event stream byte for byte.
 */

const scenario = () => createNetworkScenario();

export const NETWORK_DEMO_TICKS = 3000;
export const NETWORK_DEMO_SIMULATION_ID = deterministicUuid("scenario:network-demo", 0);

export function createNetworkDemoConfig(): SimulationConfig {
  return { ...scenario().config, simulation_id: NETWORK_DEMO_SIMULATION_ID };
}

const request = (tick: number, id: string, payload: unknown): LoggedCommand =>
  ({ tick, command: { command_id: id, type: "transfer.request", payload } }) as LoggedCommand;

export const NETWORK_DEMO_SCRIPT: readonly LoggedCommand[] = [
  ...scenario().openingCommands.map((command) => ({ tick: 1, command })),
  // Accepted: 3 cold-chain pallets from the cross-dock to the terminal.
  request(40, "net-0001", {
    from_site_id: "riverside-xd",
    to_site_id: "harbour-terminal",
    lines: [{ sku: "sku-cold-chain", quantity: 3 }],
  }),
  // Rejected: the fleet depot holds no pallets; the cross-dock has 16 cold-chain, 3 promised.
  request(41, "net-0002", {
    from_site_id: "fleet-depot",
    to_site_id: "riverside-xd",
    lines: [{ sku: "sku-cold-chain", quantity: 1 }],
  }),
  request(41, "net-0003", {
    from_site_id: "riverside-xd",
    to_site_id: "northgate-dc",
    lines: [{ sku: "sku-cold-chain", quantity: 14 }],
  }),
];

export interface NetworkRun {
  config: SimulationConfig;
  commands: readonly LoggedCommand[];
  events: DomainEvent[];
  rejections: CommandRejection[];
  finalState: SimulationState;
  invariantViolations: string[];
  summary: Record<string, unknown>;
}

export function runNetworkDemo(): NetworkRun {
  const config = createNetworkDemoConfig();
  const events: DomainEvent[] = [];
  const rejections: CommandRejection[] = [];
  const invariantViolations: string[] = [];
  const finalState = replay(config, NETWORK_DEMO_SCRIPT, NETWORK_DEMO_TICKS, (r) => {
    events.push(...r.events);
    rejections.push(...r.rejections);
    if (r.state.tick % 500 === 0)
      invariantViolations.push(
        ...checkInvariants(config, r.state).map((v) => `t${r.state.tick}: ${v}`),
      );
  });
  invariantViolations.push(...checkInvariants(config, finalState));
  const counts: Record<string, number> = {};
  const transfers: Record<string, string> = {};
  const delivered: Record<string, number> = {};
  for (const e of events) {
    counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
    if (e.event_type === "transfer.status_changed") {
      transfers[e.payload.transfer_id] = e.payload.to;
      if (e.payload.to === "delivered") {
        const lane = `${e.payload.from_site_id}->${e.payload.to_site_id}`;
        delivered[lane] = (delivered[lane] ?? 0) + cargoTotal(e.payload.lines);
      }
    }
  }
  const sorted = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).sort());
  const net = finalState.network;
  return {
    config,
    commands: NETWORK_DEMO_SCRIPT,
    events,
    rejections,
    finalState,
    invariantViolations,
    summary: {
      simulation_id: config.simulation_id,
      ticks: finalState.tick,
      event_count: events.length,
      event_counts_by_type: sorted(counts),
      rejection_codes: Object.fromEntries(rejections.map((r) => [r.command_id, r.code])),
      transfers: sorted(transfers),
      pallets_delivered_by_lane: sorted(delivered),
      vehicles: sorted(
        Object.fromEntries(Object.values(net?.vehicles ?? {}).map((v) => [v.id, v.status])),
      ),
      site_stock: sorted(
        Object.fromEntries(
          Object.entries(net?.sites ?? {}).map(([id, s]) => [
            id,
            Object.values(s.stock).reduce((a, b) => a + b, 0),
          ]),
        ),
      ),
      final_state_hash: stateHash(config, finalState),
    },
  };
}
