import type { DomainEvent } from "@warehouse-one/contracts";
import { checkInvariants, replay, totalsBySku } from "../engine";
import { deterministicUuid } from "../hash";
import { stateHash } from "../snapshot";
import type { CommandRejection, LoggedCommand, SimulationConfig, SimulationState } from "../types";
import { createEmptyScenario } from "./warehouse";

/**
 * Operations reference run (Phase 2): a scripted day on the empty facility, without the random
 * workload, covering every operator command and the full inbound → storage → outbound flow:
 * stock received, an inbound truck unloaded and put away, an outbound order picked, loaded and
 * shipped, a relocation, and four commands the rules must reject. The fixture in
 * `data/fixtures/operations-demo` pins its event stream and final state byte for byte.
 */

const cmd = (tick: number, command_id: string, type: string, payload: unknown): LoggedCommand =>
  ({ tick, command: { command_id, type, payload } }) as LoggedCommand;

export const OPERATIONS_DEMO_SCRIPT: readonly LoggedCommand[] = [
  // Opening stock: plt-000001..4 (std) in loc-01-004, plt-000005..6 (electronics) in loc-03-009.
  cmd(1, "ops-0001", "inventory.receive", {
    location_id: "loc-01-004",
    sku: "sku-std-pallet",
    quantity: 4,
  }),
  cmd(1, "ops-0002", "inventory.receive", {
    location_id: "loc-03-009",
    sku: "sku-electronics",
    quantity: 2,
  }),
  // An inbound truck with 3 pallets (plt-000007..9).
  cmd(1, "ops-0003", "truck.schedule_inbound", { cargo: [{ sku: "sku-bulk-bags", quantity: 3 }] }),
  // An outbound order: allocates plt-000001..3 and plt-000005.
  cmd(2, "ops-0004", "order.create", {
    lines: [
      { sku: "sku-std-pallet", quantity: 3 },
      { sku: "sku-electronics", quantity: 1 },
    ],
  }),
  // A relocation of the remaining free std pallet.
  cmd(3, "ops-0005", "pallet.relocate", { pallet_id: "plt-000004", to_location_id: "loc-05-012" }),
  // Rejected: not enough free electronics; pallet allocated to the order; unknown pallet;
  // the order's truck already has a dock.
  cmd(4, "ops-0006", "order.create", { lines: [{ sku: "sku-electronics", quantity: 5 }] }),
  cmd(4, "ops-0007", "pallet.relocate", { pallet_id: "plt-000001", to_location_id: "loc-00-001" }),
  cmd(4, "ops-0008", "pallet.relocate", { pallet_id: "plt-999999", to_location_id: "loc-00-001" }),
  cmd(5, "ops-0009", "order.cancel", { order_id: "ord-000001" }),
];

/** Long enough for every task to finish, both trucks to leave and vehicles to return home. */
export const OPERATIONS_DEMO_TICKS = 6000;

export const OPERATIONS_DEMO_SIMULATION_ID = deterministicUuid("scenario:operations-demo", 0);

export function createOperationsDemoConfig(): SimulationConfig {
  return { ...createEmptyScenario().config, simulation_id: OPERATIONS_DEMO_SIMULATION_ID };
}

export interface OperationsRun {
  config: SimulationConfig;
  commands: readonly LoggedCommand[];
  events: DomainEvent[];
  rejections: CommandRejection[];
  finalState: SimulationState;
  invariantViolations: string[];
  summary: {
    simulation_id: string;
    ticks: number;
    event_count: number;
    event_counts_by_type: Record<string, number>;
    rejection_codes: Record<string, string>;
    orders: Record<string, string>;
    trucks: Record<string, string>;
    tasks_completed_by_type: Record<string, number>;
    final_pallets: Record<string, string>;
    final_totals_by_sku: Record<string, number>;
    final_state_hash: string;
  };
}

export function runOperationsDemo(): OperationsRun {
  const config = createOperationsDemoConfig();
  const events: DomainEvent[] = [];
  const rejections: CommandRejection[] = [];
  const invariantViolations: string[] = [];
  const finalState = replay(config, OPERATIONS_DEMO_SCRIPT, OPERATIONS_DEMO_TICKS, (r) => {
    events.push(...r.events);
    rejections.push(...r.rejections);
    if (r.state.tick % 100 === 0)
      invariantViolations.push(
        ...checkInvariants(config, r.state).map((v) => `t${r.state.tick}: ${v}`),
      );
  });
  const counts: Record<string, number> = {};
  const orders: Record<string, string> = {};
  const trucks: Record<string, string> = {};
  const created = new Map<string, string>();
  const completed: Record<string, number> = {};
  for (const e of events) {
    counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
    if (e.event_type === "order.status_changed") orders[e.payload.order_id] = e.payload.to;
    if (e.event_type === "truck.status_changed") trucks[e.payload.truck_id] = e.payload.to;
    if (e.event_type === "task.created") created.set(e.payload.task_id, e.payload.task_type);
    if (e.event_type === "task.completed") {
      const type = created.get(e.payload.task_id) ?? "unknown";
      completed[type] = (completed[type] ?? 0) + 1;
    }
  }
  const sorted = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).sort());
  const pallets = finalState.ops?.pallets ?? {};
  return {
    config,
    commands: OPERATIONS_DEMO_SCRIPT,
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
      orders: sorted(orders),
      trucks: sorted(trucks),
      tasks_completed_by_type: sorted(completed),
      final_pallets: sorted(
        Object.fromEntries(
          Object.values(pallets).map((p) => [
            p.id,
            p.at.kind === "slot" ? `${p.at.location_id}#${p.at.slot}` : p.at.kind,
          ]),
        ),
      ),
      final_totals_by_sku: sorted(totalsBySku(finalState)),
      final_state_hash: stateHash(config, finalState),
    },
  };
}
