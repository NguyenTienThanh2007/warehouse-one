import { EntityId, parseCommand, Uuid } from "@warehouse-one/contracts";
import { TickDraft } from "./draft";
import { applyCommand } from "./handlers";
import { seedRng } from "./rng";
import { syntheticWorkloadSystem } from "./systems/synthetic-workload";
import type {
  CommandRejection,
  LoggedCommand,
  SimulationConfig,
  SimulationState,
  StepResult,
} from "./types";

/** Systems run every tick, after commands, in this fixed order. */
const SYSTEMS = [syntheticWorkloadSystem] as const;

interface Indexes {
  locations: ReadonlyMap<string, SimulationConfig["locations"][number]>;
  skus: ReadonlySet<string>;
}
const indexCache = new WeakMap<SimulationConfig, Indexes>();

function indexes(config: SimulationConfig): Indexes {
  let idx = indexCache.get(config);
  if (!idx) {
    idx = {
      locations: new Map(config.locations.map((l) => [l.id, l])),
      skus: new Set(config.skus.map((s) => s.id)),
    };
    indexCache.set(config, idx);
  }
  return idx;
}

/** Returns a list of problems; an empty list means the config is valid. */
export function validateConfig(config: SimulationConfig): string[] {
  const problems: string[] = [];
  if (!Uuid.safeParse(config.simulation_id).success) problems.push("simulation_id must be a UUID");
  if (!Number.isInteger(config.tick_ms) || config.tick_ms <= 0) problems.push("tick_ms must be a positive integer");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(config.epoch) || Number.isNaN(Date.parse(config.epoch))) {
    problems.push("epoch must be an ISO-8601 UTC timestamp with millisecond precision");
  }
  const seen = new Set<string>();
  for (const l of config.locations) {
    if (!EntityId.safeParse(l.id).success) problems.push(`location id '${l.id}' is not a valid slug`);
    if (seen.has(l.id)) problems.push(`duplicate location id '${l.id}'`);
    seen.add(l.id);
    if (!Number.isInteger(l.capacity) || l.capacity <= 0) problems.push(`location '${l.id}' capacity must be a positive integer`);
  }
  const skus = new Set<string>();
  for (const s of config.skus) {
    if (!EntityId.safeParse(s.id).success) problems.push(`sku id '${s.id}' is not a valid slug`);
    if (skus.has(s.id)) problems.push(`duplicate sku id '${s.id}'`);
    skus.add(s.id);
  }
  const w = config.synthetic_workload;
  if (w) {
    for (const p of [w.inbound_probability, w.move_probability]) {
      if (!(p >= 0 && p <= 1)) problems.push("synthetic workload probabilities must be within [0, 1]");
    }
    if (!Number.isInteger(w.max_quantity) || w.max_quantity < 1) problems.push("synthetic max_quantity must be >= 1");
  }
  return problems;
}

export function createInitialState(config: SimulationConfig): SimulationState {
  const problems = validateConfig(config);
  if (problems.length > 0) throw new Error(`invalid simulation config: ${problems.join("; ")}`);
  return { tick: 0, sequence: 0, rng: seedRng(config.seed), inventory: {}, aggregate_versions: {} };
}

/**
 * Advance the simulation by exactly one fixed tick. Pure: same (config, state, commands) always
 * yields the same result, and the input state is never mutated.
 *
 * Order within a tick: tick counter increments, commands apply in submission order (each sees the
 * effects of the previous one, so conflicting commands are rejected rather than double-applied),
 * then systems run in a fixed order.
 *
 * `commands` is untrusted: each is schema-validated and invalid ones are rejected, never thrown.
 */
export function step(config: SimulationConfig, state: SimulationState, commands: readonly unknown[] = []): StepResult {
  const draft = new TickDraft(config, state, indexes(config));
  const rejections: CommandRejection[] = [];

  for (const raw of commands) {
    const parsed = parseCommand(raw);
    if (!parsed.ok) {
      const id = typeof raw === "object" && raw !== null && "command_id" in raw ? String(raw.command_id) : "(unknown)";
      rejections.push({ command_id: id, tick: draft.tick, code: "INVALID_COMMAND", message: parsed.issues.join("; ") });
      continue;
    }
    const result = applyCommand(draft, parsed.value);
    if (!result.ok) {
      rejections.push({ command_id: parsed.value.command_id, tick: draft.tick, code: result.code, message: result.message });
    }
  }

  for (const system of SYSTEMS) system(draft);

  return { state: draft.commit(), events: draft.events, rejections };
}

/**
 * Rebuild state from the initial config and a command log. Replaying the same seed and
 * commands produces an identical state and identical events.
 */
export function replay(
  config: SimulationConfig,
  log: readonly LoggedCommand[],
  untilTick: number,
  onStep?: (result: StepResult) => void,
): SimulationState {
  const byTick = new Map<number, LoggedCommand["command"][]>();
  for (const entry of log) {
    const list = byTick.get(entry.tick) ?? [];
    list.push(entry.command);
    byTick.set(entry.tick, list);
  }
  let state = createInitialState(config);
  while (state.tick < untilTick) {
    const result = step(config, state, byTick.get(state.tick + 1) ?? []);
    onStep?.(result);
    state = result.state;
  }
  return state;
}

/** Checks the core inventory invariants. Returns violations (empty = healthy). */
export function checkInvariants(config: SimulationConfig, state: SimulationState): string[] {
  const { locations, skus } = indexes(config);
  const violations: string[] = [];
  for (const [locationId, row] of Object.entries(state.inventory)) {
    const loc = locations.get(locationId);
    if (!loc) violations.push(`inventory at unknown location '${locationId}'`);
    let total = 0;
    for (const [sku, q] of Object.entries(row)) {
      if (!skus.has(sku)) violations.push(`unknown sku '${sku}' at '${locationId}'`);
      if (!Number.isInteger(q) || q <= 0) violations.push(`non-positive or fractional quantity ${q} at '${locationId}/${sku}'`);
      total += q;
    }
    if (loc && total > loc.capacity) violations.push(`location '${locationId}' over capacity (${total}/${loc.capacity})`);
  }
  return violations;
}

/** Total units per SKU across all locations. */
export function totalsBySku(state: SimulationState): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of Object.values(state.inventory)) {
    for (const [sku, q] of Object.entries(row)) totals[sku] = (totals[sku] ?? 0) + q;
  }
  return totals;
}
