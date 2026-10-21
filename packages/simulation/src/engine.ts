import { EntityId, parseCommand, Uuid } from "@warehouse-one/contracts";
import { TickDraft } from "./draft";
import { applyCommand } from "./handlers";
import { initialOperations } from "./ops/init";
import { checkOpsInvariants } from "./ops/invariants";
import { navGraph } from "./ops/nav";
import { seedRng } from "./rng";
import { syntheticWorkloadSystem } from "./systems/synthetic-workload";
import { operationsSystem } from "./ops/systems";
import type {
  CommandRejection,
  LoggedCommand,
  SimulationConfig,
  SimulationState,
  StepResult,
} from "./types";

/** Systems run every tick, after commands, in this fixed order. */
const SYSTEMS = [syntheticWorkloadSystem, operationsSystem] as const;

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
  if (!Number.isInteger(config.tick_ms) || config.tick_ms <= 0)
    problems.push("tick_ms must be a positive integer");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(config.epoch) ||
    Number.isNaN(Date.parse(config.epoch))
  ) {
    problems.push("epoch must be an ISO-8601 UTC timestamp with millisecond precision");
  }
  const seen = new Set<string>();
  for (const l of config.locations) {
    if (!EntityId.safeParse(l.id).success)
      problems.push(`location id '${l.id}' is not a valid slug`);
    if (seen.has(l.id)) problems.push(`duplicate location id '${l.id}'`);
    seen.add(l.id);
    if (!Number.isInteger(l.capacity) || l.capacity <= 0)
      problems.push(`location '${l.id}' capacity must be a positive integer`);
  }
  const skus = new Set<string>();
  for (const s of config.skus) {
    if (!EntityId.safeParse(s.id).success) problems.push(`sku id '${s.id}' is not a valid slug`);
    if (skus.has(s.id)) problems.push(`duplicate sku id '${s.id}'`);
    skus.add(s.id);
  }
  if (config.facility) problems.push(...validateFacility(config));
  const w = config.synthetic_workload;
  if (w) {
    for (const p of [w.inbound_probability, w.move_probability]) {
      if (!(p >= 0 && p <= 1))
        problems.push("synthetic workload probabilities must be within [0, 1]");
    }
    if (!Number.isInteger(w.max_quantity) || w.max_quantity < 1)
      problems.push("synthetic max_quantity must be >= 1");
  }
  return problems;
}

const EQUIPMENT_KINDS = new Set(["counterbalance_forklift", "reach_truck", "truck"]);

function validateFacility(config: SimulationConfig): string[] {
  const f = config.facility;
  if (!f) return [];
  const problems: string[] = [];
  const { min, max, height } = f.building;
  if (!(max.x > min.x && max.z > min.z && height > 0))
    problems.push("facility building bounds are empty");
  if (!(
    f.site.min.x <= min.x &&
    f.site.min.z <= min.z &&
    f.site.max.x >= max.x &&
    f.site.max.z >= max.z
  )) {
    problems.push("facility site must contain the building");
  }
  const r = f.rack;
  if (
    !(r.bay_width > 0 && r.depth > 0 && r.level_height > 0) ||
    !Number.isInteger(r.positions_per_level) ||
    r.positions_per_level < 1
  ) {
    problems.push(
      "facility rack spec must have positive dimensions and integer positions_per_level",
    );
  }
  const inside = (p: { x: number; z: number }) =>
    p.x >= min.x && p.x <= max.x && p.z >= min.z && p.z <= max.z;
  for (const l of config.locations) {
    if (!inside(l.position)) problems.push(`location '${l.id}' lies outside the building`);
  }
  const ids = new Set<string>();
  for (const d of f.docks) {
    if (!EntityId.safeParse(d.id).success) problems.push(`dock id '${d.id}' is not a valid slug`);
    if (ids.has(d.id)) problems.push(`duplicate facility id '${d.id}'`);
    ids.add(d.id);
  }
  for (const e of f.equipment) {
    if (!EntityId.safeParse(e.id).success)
      problems.push(`equipment id '${e.id}' is not a valid slug`);
    if (ids.has(e.id)) problems.push(`duplicate facility id '${e.id}'`);
    ids.add(e.id);
    if (!EQUIPMENT_KINDS.has(e.kind))
      problems.push(`equipment '${e.id}' has unknown kind '${e.kind}'`);
    if (e.dock_id !== undefined && !f.docks.some((d) => d.id === e.dock_id)) {
      problems.push(`equipment '${e.id}' references unknown dock '${e.dock_id}'`);
    }
    if (e.kind === "truck") {
      problems.push(
        `equipment '${e.id}': trucks are scheduled at run time (truck.schedule_inbound, order.create), not facility equipment`,
      );
    }
    if (/^(plt|tsk|trk|ord)-/.test(e.id))
      problems.push(`equipment id '${e.id}' uses a reserved run-time id prefix`);
    if (
      e.battery_permille !== undefined &&
      !(
        Number.isInteger(e.battery_permille) &&
        e.battery_permille >= 0 &&
        e.battery_permille <= 1000
      )
    ) {
      problems.push(`equipment '${e.id}' battery_permille must be an integer in [0, 1000]`);
    }
  }
  if (problems.length === 0)
    problems.push(...navGraph(config).problems.map((p) => `navigation: ${p}`));
  const w = config.operations_workload;
  if (w) {
    for (const k of [
      "inbound_interval_ticks",
      "outbound_interval_ticks",
      "relocate_interval_ticks",
    ] as const) {
      if (!Number.isInteger(w[k]) || w[k] < 0)
        problems.push(`operations_workload.${k} must be a non-negative integer`);
    }
    if (!(
      Number.isInteger(w.min_pallets) &&
      w.min_pallets >= 1 &&
      Number.isInteger(w.max_pallets) &&
      w.max_pallets >= w.min_pallets &&
      w.max_pallets <= 26
    )) {
      problems.push("operations_workload pallets must satisfy 1 <= min <= max <= 26");
    }
  }
  return problems;
}

export function createInitialState(config: SimulationConfig): SimulationState {
  const problems = validateConfig(config);
  if (problems.length > 0) throw new Error(`invalid simulation config: ${problems.join("; ")}`);
  const ops = initialOperations(config);
  return {
    tick: 0,
    sequence: 0,
    rng: seedRng(config.seed),
    inventory: {},
    aggregate_versions: {},
    ...(ops ? { ops } : {}),
  };
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
export function step(
  config: SimulationConfig,
  state: SimulationState,
  commands: readonly unknown[] = [],
): StepResult {
  const draft = new TickDraft(config, state, indexes(config));
  const rejections: CommandRejection[] = [];

  for (const raw of commands) {
    const parsed = parseCommand(raw);
    if (!parsed.ok) {
      const id =
        typeof raw === "object" && raw !== null && "command_id" in raw
          ? String(raw.command_id)
          : "(unknown)";
      rejections.push({
        command_id: id,
        tick: draft.tick,
        code: "INVALID_COMMAND",
        message: parsed.issues.join("; "),
      });
      continue;
    }
    const result = applyCommand(draft, parsed.value);
    if (!result.ok) {
      rejections.push({
        command_id: parsed.value.command_id,
        tick: draft.tick,
        code: result.code,
        message: result.message,
      });
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
      if (!Number.isInteger(q) || q <= 0)
        violations.push(`non-positive or fractional quantity ${q} at '${locationId}/${sku}'`);
      total += q;
    }
    if (loc && total > loc.capacity)
      violations.push(`location '${locationId}' over capacity (${total}/${loc.capacity})`);
  }
  violations.push(...checkOpsInvariants(config, state));
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
