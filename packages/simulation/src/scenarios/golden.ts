import type { DomainEvent } from "@warehouse-one/contracts";
import { replay, totalsBySku } from "../engine";
import { stateHash } from "../snapshot";
import type { CommandRejection, LoggedCommand, SimulationConfig, SimulationState } from "../types";
import {
  createFoundationDemoConfig,
  FOUNDATION_DEMO_SCRIPT,
  FOUNDATION_DEMO_TICKS,
} from "./foundation-demo";

export interface GoldenRun {
  config: SimulationConfig;
  commands: readonly LoggedCommand[];
  events: DomainEvent[];
  rejections: CommandRejection[];
  finalState: SimulationState;
  summary: {
    simulation_id: string;
    ticks: number;
    final_simulation_time_ms: number;
    event_count: number;
    event_counts_by_type: Record<string, number>;
    rejection_codes: Record<string, string>;
    final_totals_by_sku: Record<string, number>;
    final_state_hash: string;
  };
}

/** Deterministic reference run shared by the golden-file test and the fixture generator. */
export function runGolden(): GoldenRun {
  const config = createFoundationDemoConfig();
  const events: DomainEvent[] = [];
  const rejections: CommandRejection[] = [];
  const finalState = replay(config, FOUNDATION_DEMO_SCRIPT, FOUNDATION_DEMO_TICKS, (r) => {
    events.push(...r.events);
    rejections.push(...r.rejections);
  });
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
  return {
    config,
    commands: FOUNDATION_DEMO_SCRIPT,
    events,
    rejections,
    finalState,
    summary: {
      simulation_id: config.simulation_id,
      ticks: finalState.tick,
      final_simulation_time_ms: finalState.tick * config.tick_ms,
      event_count: events.length,
      event_counts_by_type: Object.fromEntries(Object.entries(counts).sort()),
      rejection_codes: Object.fromEntries(rejections.map((r) => [r.command_id, r.code])),
      final_totals_by_sku: Object.fromEntries(Object.entries(totalsBySku(finalState)).sort()),
      final_state_hash: stateHash(config, finalState),
    },
  };
}

export function renderGoldenFiles(
  run: Pick<GoldenRun, "config" | "commands" | "events"> & { summary: unknown },
): Record<string, string> {
  const jsonl = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  return {
    "config.json": `${JSON.stringify(run.config, null, 2)}\n`,
    "commands.jsonl": jsonl(run.commands),
    "events.jsonl": jsonl(run.events),
    "summary.json": `${JSON.stringify(run.summary, null, 2)}\n`,
  };
}
