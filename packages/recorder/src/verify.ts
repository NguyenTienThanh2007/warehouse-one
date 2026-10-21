import type { DomainEvent } from "@warehouse-one/contracts";
import {
  replay,
  stableStringify,
  type LoggedCommand,
  type SimulationConfig,
} from "@warehouse-one/simulation";

export interface ReplayCheck {
  readonly ok: boolean;
  readonly storedEvents: number;
  readonly replayedEvents: number;
  readonly replayedThroughTick: number;
  readonly mismatches: readonly { sequence: number; reason: string }[];
}

/**
 * Replay a stored run's command log in the engine and compare every stored event with the replayed
 * event at the same position (canonical JSON). Detects altered, missing and invented events, and
 * events the engine produced up to the last stored tick that were never stored.
 */
export function checkReplay(
  config: SimulationConfig,
  commands: readonly LoggedCommand[],
  stored: readonly DomainEvent[],
  throughTick: number,
): ReplayCheck {
  const lastTick = stored.length
    ? (stored.at(-1)?.simulation_time_ms ?? 0) / config.tick_ms
    : throughTick;
  const replayed: DomainEvent[] = [];
  replay(config, commands, lastTick, (r) => replayed.push(...r.events));
  const mismatches: { sequence: number; reason: string }[] = [];
  stored.forEach((event, i) => {
    const twin = replayed[i];
    if (!twin) mismatches.push({ sequence: event.sequence, reason: "not produced by the replay" });
    else if (stableStringify(twin) !== stableStringify(event))
      mismatches.push({ sequence: event.sequence, reason: "differs from the replay" });
  });
  const lost = replayed
    .slice(stored.length)
    .filter((e) => e.simulation_time_ms / config.tick_ms < lastTick).length;
  if (lost)
    mismatches.push({
      sequence: stored.length + 1,
      reason: `${lost} replayed events before the last stored tick were not stored`,
    });
  return {
    ok: mismatches.length === 0,
    storedEvents: stored.length,
    replayedEvents: replayed.length,
    replayedThroughTick: lastTick,
    mismatches,
  };
}
