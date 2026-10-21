/**
 * Verify a stored run by replaying it in the TypeScript engine (DEC-024): fetch the run's config,
 * command log and events from the API, replay the commands with `replay()`, and compare every
 * stored event with the replayed event of the same sequence (canonical JSON). This checks the
 * business semantics the API itself cannot check.
 *
 *   pnpm sim:verify --api http://localhost:8010 --simulation <uuid>
 *
 * Exits 0 when every stored event matches, 1 on any mismatch or missing event.
 */
import type { DomainEvent } from "@warehouse-one/contracts";
import type { LoggedCommand, SimulationConfig } from "@warehouse-one/simulation";
import { checkReplay } from "../src/verify";
import { args, required } from "./args";

const a = args();
const api = required(a, "api").replace(/\/$/, "");
const id = required(a, "simulation");
const base = `${api}/api/v1/simulations/${id}`;

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const run = await get<{ config: SimulationConfig; through_tick: number; last_sequence: number }>(
  base,
);
const { commands } = await get<{ commands: LoggedCommand[] }>(`${base}/commands`);
const stored: DomainEvent[] = [];
for (let after = 0; ;) {
  const page = await get<{ events: DomainEvent[]; next_after_sequence: number | null }>(
    `${base}/events?after_sequence=${after}&limit=5000`,
  );
  stored.push(...page.events);
  if (page.next_after_sequence === null) break;
  after = page.next_after_sequence;
}

const check = checkReplay(run.config, commands, stored, run.through_tick);
const ok = check.ok && stored.length === run.last_sequence;
console.log(
  JSON.stringify({
    ok,
    simulation_id: id,
    stored_events: check.storedEvents,
    recorded_last_sequence: run.last_sequence,
    replayed_events: check.replayedEvents,
    commands: commands.length,
    replayed_through_tick: check.replayedThroughTick,
    mismatches: check.mismatches.slice(0, 10),
  }),
);
process.exit(ok ? 0 : 1);
