"use client";

import type {
  CargoLine,
  DomainEvent,
  SimulationCommand,
  SimulationCommandType,
} from "@warehouse-one/contracts";
import {
  createScenario,
  isScenarioId,
  linehaulPose,
  SimulationRunner,
  stateHash,
  type CommandRejection,
  type RejectionCode,
  type Scenario,
  type ScenarioId,
  type SimulationConfig,
  type SimulationState,
} from "@warehouse-one/simulation";
import { RunRecorder, withFreshRunId, type RecorderStatus } from "@warehouse-one/recorder";
import { create } from "zustand";
import { API_URL } from "../api/health";
import { truckViews, vehicleViews } from "../../world/ops-view";

/** What the user has selected in the world. IDs always refer to config/state entities. */
export type Selection =
  | { readonly kind: "location"; readonly id: string }
  | { readonly kind: "equipment"; readonly id: string }
  | { readonly kind: "dock"; readonly id: string }
  | { readonly kind: "truck"; readonly id: string }
  /** Phase 5: a site of the logistics network, and a line-haul truck. */
  | { readonly kind: "site"; readonly id: string }
  | { readonly kind: "linehaul"; readonly id: string };

/** A command as the operator UI builds it; the store adds the command id. */
export type CommandInput = {
  [K in SimulationCommandType]: {
    readonly type: K;
    readonly payload: Extract<SimulationCommand, { type: K }>["payload"];
  };
}[SimulationCommandType];

/** An operator command and what the simulation did with it. */
export interface CommandRecord {
  readonly command_id: string;
  readonly type: SimulationCommandType;
  readonly summary: string;
  /** Tick shown when the command was submitted; it applies on the next tick. */
  readonly submittedAtTick: number;
  readonly status: "pending" | "accepted" | "rejected";
  readonly appliedTick?: number;
  /** Rejection code from the engine, or INVALID_COMMAND for schema errors caught at submit. */
  readonly code?: RejectionCode;
  readonly message?: string;
}

/** Orders leave operational state when they finish; their outcome is kept from the events. */
export interface FinishedOrder {
  readonly order_id: string;
  readonly status: "shipped" | "cancelled";
  readonly tick: number;
  readonly truck_id: string;
  readonly lines: readonly CargoLine[];
}

/**
 * UI-facing projection of the authoritative simulation. Components read from here; only the
 * actions below talk to the runner, and the runner publishes deeply frozen state, so rendering
 * can never alter business state.
 */
export interface SimulationView {
  readonly scenarioId: ScenarioId;
  readonly config: SimulationConfig;
  readonly tick: number;
  readonly simTimeMs: number;
  readonly paused: boolean;
  readonly speed: number;
  readonly eventCount: number;
  readonly rejectionCount: number;
  readonly recentEvents: readonly DomainEvent[];
  readonly inventory: SimulationState["inventory"];
  /** Latest published (frozen) state, and the state one tick earlier for render interpolation. */
  readonly state: SimulationState;
  readonly prevState: SimulationState;
  readonly stateHash: string;
  readonly selection: Selection | null;
  /** Most recent operator commands first. */
  readonly commands: readonly CommandRecord[];
  /** Most recently finished orders first. */
  readonly finishedOrders: readonly FinishedOrder[];
  /** Recording to the API (DEC-024): null when off, else the recorder's live status. */
  readonly recording: RecorderStatus | null;
}

interface SimulationActions {
  advance(realDeltaMs: number): void;
  togglePause(): void;
  setSpeed(factor: number): void;
  stepOnce(): void;
  reset(): void;
  select(selection: Selection | null): void;
  /** Replace the running scenario. Starts a fresh run and applies its opening commands at tick 1. */
  loadScenario(id: ScenarioId): void;
  /**
   * Queue an operator command for the next tick, through the same validated command path as every
   * other input. Schema errors are rejected immediately; business rules are checked by the engine.
   */
  submitCommand(input: CommandInput): CommandRecord;
  /**
   * Turn recording on or off. Turning it on restarts the current scenario as a new run with a
   * fresh simulation_id (so its event IDs are unique) and streams it to the API from tick 1.
   */
  setRecording(on: boolean): void;
}

export const SPEED_PRESETS = [0.5, 1, 2, 4, 8] as const;
/** The multi-site logistics park; `?scenario=showcase` opens the single-site DC. */
export const DEFAULT_SCENARIO: ScenarioId = "network";
const RECENT_EVENTS = 6;
const RECENT_COMMANDS = 8;
const RECENT_ORDERS = 8;

interface Started {
  runner: SimulationRunner;
  events: readonly DomainEvent[];
  rejections: number;
}

/** How often the recorder sends what the run produced since the last batch. */
const RECORD_FLUSH_MS = 1000;
let recorder: RunRecorder | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let publishRecording: (status: RecorderStatus | null) => void = () => {};

/** The active recorder's status (a function, so callers never see a stale narrowed value). */
function currentRecording(): RecorderStatus | null {
  return recorder?.status() ?? null;
}

function stopRecorder(): RecorderStatus | null {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  const last = recorder?.status() ?? null;
  recorder?.stop();
  recorder = null;
  return last ? { ...last, state: last.state === "failed" ? "failed" : "stopped" } : null;
}

/**
 * Opening stock goes through submit + step like any command: logged, validated, replayable. A
 * recorded run gets a fresh simulation_id and its recorder is attached before the first step, so
 * the opening commands and events are recorded too.
 */
function start(scenario: Scenario, record = false): Started {
  const config = record ? withFreshRunId(scenario.config) : scenario.config;
  const runner = new SimulationRunner(config);
  if (record) {
    recorder = new RunRecorder({
      apiUrl: API_URL,
      config,
      scenarioId: scenario.id,
      source: "web",
      onStatus: (s) => publishRecording(s),
    });
    recorder.attach(runner);
    const active = recorder;
    flushTimer = setInterval(() => {
      // Failures are reported through the status; a rejected run stays stopped.
      if (active.status().state !== "failed") active.flush().catch(() => {});
    }, RECORD_FLUSH_MS);
  }
  if (scenario.openingCommands.length === 0) return { runner, events: [], rejections: 0 };
  for (const c of scenario.openingCommands) runner.submit(c);
  const r = runner.stepOnce();
  return { runner, events: r.events, rejections: r.rejections.length };
}

const initial = start(createScenario(DEFAULT_SCENARIO));
let runner = initial.runner;
/** State before the latest tick (for interpolation); tracked from the runner's step stream. */
let previous = runner.state;
let latest = runner.state;
let unsubscribe = track(runner);
let commandSeq = 0;

function track(r: SimulationRunner): () => void {
  previous = r.state;
  latest = r.state;
  return r.subscribe((result) => {
    previous = latest;
    latest = result.state;
  });
}

const recent = (events: readonly DomainEvent[]) => [...events.slice(-RECENT_EVENTS)].reverse();

function project(
  r: SimulationRunner,
): Pick<
  SimulationView,
  "tick" | "simTimeMs" | "paused" | "speed" | "inventory" | "state" | "prevState" | "stateHash"
> {
  return {
    tick: r.state.tick,
    simTimeMs: r.simulationTimeMs,
    paused: r.paused,
    speed: r.speed,
    inventory: r.state.inventory,
    state: r.state,
    prevState: previous,
    stateHash: stateHash(r.config, r.state),
  };
}

/** The authoritative, replayable command log of the current run (read-only). */
export function commandLog() {
  return runner.commandLog;
}

/**
 * Render-time interpolation factor between `prevState` (0) and `state` (1): the fraction of the
 * next tick already elapsed. Paused runs show the latest state exactly.
 */
export function renderAlpha(): number {
  return runner.paused ? 1 : runner.tickProgress;
}

function finishedOrders(
  config: SimulationConfig,
  events: readonly DomainEvent[],
  before: readonly FinishedOrder[],
): readonly FinishedOrder[] {
  const done: FinishedOrder[] = [];
  for (const e of events) {
    if (e.event_type !== "order.status_changed") continue;
    if (e.payload.to !== "shipped" && e.payload.to !== "cancelled") continue;
    done.push({
      order_id: e.payload.order_id,
      status: e.payload.to,
      tick: e.simulation_time_ms / config.tick_ms,
      truck_id: e.payload.truck_id,
      lines: e.payload.lines,
    });
  }
  return done.length ? [...done.reverse(), ...before].slice(0, RECENT_ORDERS) : before;
}

/** Settle pending commands after ticks ran: each one was applied or rejected by the engine. */
function settle(
  records: readonly CommandRecord[],
  rejections: readonly CommandRejection[],
): readonly CommandRecord[] {
  if (!records.some((c) => c.status === "pending")) return records;
  const rejected = new Map(rejections.map((r) => [r.command_id, r]));
  const log = runner.commandLog;
  const appliedAt = (id: string) => {
    for (let i = log.length - 1; i >= 0; i--)
      if (log[i]?.command.command_id === id) return log[i]?.tick;
    return undefined;
  };
  return records.map((c) => {
    if (c.status !== "pending") return c;
    const appliedTick = appliedAt(c.command_id);
    if (appliedTick === undefined) return c;
    const r = rejected.get(c.command_id);
    return r
      ? { ...c, status: "rejected", appliedTick, code: r.code, message: r.message }
      : { ...c, status: "accepted", appliedTick };
  });
}

export const useSimulation = create<SimulationView & SimulationActions>()((set, get) => {
  publishRecording = (recording) => set({ recording });
  const absorb = (events: readonly DomainEvent[], rejections: readonly CommandRejection[]) => {
    const s = get();
    set({
      ...project(runner),
      eventCount: s.eventCount + events.length,
      rejectionCount: s.rejectionCount + rejections.length,
      recentEvents: events.length
        ? [...events.slice(-RECENT_EVENTS).reverse(), ...s.recentEvents].slice(0, RECENT_EVENTS)
        : s.recentEvents,
      commands: settle(s.commands, rejections),
      finishedOrders: finishedOrders(runner.config, events, s.finishedOrders),
    });
  };

  return {
    scenarioId: DEFAULT_SCENARIO,
    config: runner.config,
    ...project(runner),
    // The opening step's events are part of the run; count and show them from the start.
    eventCount: initial.events.length,
    rejectionCount: initial.rejections,
    recentEvents: recent(initial.events),
    selection: null,
    commands: [],
    finishedOrders: [],
    recording: null,

    advance(realDeltaMs) {
      const r = runner.advance(realDeltaMs);
      if (r.ticks > 0) absorb(r.events, r.rejections);
    },
    togglePause() {
      if (runner.paused) runner.resume();
      else runner.pause();
      set({ paused: runner.paused });
    },
    setSpeed(factor) {
      runner.setSpeed(factor);
      set({ speed: runner.speed });
    },
    stepOnce() {
      const r = runner.stepOnce();
      absorb(r.events, r.rejections);
    },
    reset() {
      get().loadScenario(get().scenarioId);
    },
    select(selection) {
      set({ selection });
    },
    loadScenario(id) {
      const wasPaused = runner.paused;
      unsubscribe();
      // A recording session follows the user to the new scenario as a new recorded run.
      const record = recorder !== null;
      stopRecorder();
      const started = start(createScenario(id), record);
      runner = started.runner;
      unsubscribe = track(runner);
      runner.setSpeed(get().speed);
      if (!wasPaused) runner.resume();
      set({
        scenarioId: id,
        config: runner.config,
        ...project(runner),
        eventCount: started.events.length,
        rejectionCount: started.rejections,
        recentEvents: recent(started.events),
        selection: null,
        commands: [],
        finishedOrders: [],
        recording: currentRecording(),
      });
    },
    setRecording(on) {
      if (on === (recorder !== null)) return;
      if (on) {
        // Restart the scenario as a fresh recorded run (see setRecording's contract).
        const id = get().scenarioId;
        const wasPaused = runner.paused;
        unsubscribe();
        const started = start(createScenario(id), true);
        runner = started.runner;
        unsubscribe = track(runner);
        runner.setSpeed(get().speed);
        if (!wasPaused) runner.resume();
        set({
          config: runner.config,
          ...project(runner),
          eventCount: started.events.length,
          rejectionCount: started.rejections,
          recentEvents: recent(started.events),
          selection: null,
          commands: [],
          finishedOrders: [],
          recording: currentRecording(),
        });
      } else {
        set({ recording: stopRecorder() });
      }
    },
    submitCommand(input) {
      const command_id = `ui-${String(++commandSeq).padStart(4, "0")}`;
      const result = runner.submit({ command_id, type: input.type, payload: input.payload });
      const base = {
        command_id,
        type: input.type,
        summary: summarizeCommand(input),
        submittedAtTick: runner.state.tick,
      };
      const record: CommandRecord = result.accepted
        ? { ...base, status: "pending" }
        : {
            ...base,
            status: "rejected",
            code: "INVALID_COMMAND",
            message: result.issues.join("; "),
          };
      const s = get();
      set({
        commands: [record, ...s.commands].slice(0, RECENT_COMMANDS),
        rejectionCount: s.rejectionCount + (result.accepted ? 0 : 1),
      });
      return record;
    },
  };
});

/** One-line description of an operator command. */
export function summarizeCommand(c: CommandInput): string {
  const lines = (l: readonly CargoLine[]) => l.map((x) => `${x.quantity} × ${x.sku}`).join(", ");
  switch (c.type) {
    case "order.create":
      return `Order ${lines(c.payload.lines)}`;
    case "truck.schedule_inbound":
      return `Inbound truck ${lines(c.payload.cargo)}`;
    case "order.cancel":
      return `Cancel ${c.payload.order_id}`;
    case "pallet.relocate":
      return `Relocate ${c.payload.pallet_id} → ${c.payload.to_location_id}`;
    case "transfer.request":
      return `Transfer ${lines(c.payload.lines)} ${c.payload.from_site_id} → ${c.payload.to_site_id}`;
    case "inventory.receive":
      return `Receive ${c.payload.quantity} × ${c.payload.sku} → ${c.payload.location_id}`;
    case "inventory.move":
      return `Move ${c.payload.quantity} × ${c.payload.sku} ${c.payload.from_location_id} → ${c.payload.to_location_id}`;
    case "inventory.adjust":
      return `Adjust ${c.payload.delta} ${c.payload.sku} @ ${c.payload.location_id}`;
  }
}

/** What a rejection means for the operator, and what to do about it. */
export const REJECTION_EXPLANATION: Record<RejectionCode, string> = {
  INVALID_COMMAND: "The request is incomplete or malformed, so it was not sent to the simulation.",
  UNKNOWN_LOCATION: "That rack bay does not exist in this facility.",
  UNKNOWN_SKU: "That SKU is not in the item master.",
  INSUFFICIENT_STOCK:
    "Not enough free pallets of this SKU are stored in the racks. Pallets already allocated to an order or being moved do not count.",
  CAPACITY_EXCEEDED: "The bay does not have that many free positions.",
  OPERATIONS_DISABLED:
    "This scenario has no facility data, so vehicles, trucks and orders are not simulated.",
  UNKNOWN_PALLET: "No pallet with that id is on site; it may already have shipped.",
  PALLET_NOT_STORED: "Only pallets stored in a rack slot can be relocated.",
  PALLET_RESERVED: "The pallet is allocated to an order or already being moved by a task.",
  SAME_LOCATION: "The pallet is already in that bay. Choose a different destination.",
  NO_CAPACITY:
    "There is no free, unreserved position for it. Free some space or wait for put-away to finish.",
  YARD_FULL: "Every yard slot is taken. Wait for a truck to dock or leave, then try again.",
  UNKNOWN_ORDER: "The order does not exist or has already finished.",
  ORDER_NOT_CANCELLABLE:
    "Its truck already has a dock and picking has started, or it loads a line-haul truck for an inter-site transfer, so it can no longer be cancelled.",
  NETWORK_DISABLED:
    "This scenario is a single site. Open the logistics network scenario to move pallets between sites.",
  UNKNOWN_SITE: "That site is not part of this logistics network.",
  INVALID_TRANSFER:
    "Pallets can only leave the terminal, the cross-dock or the DC, and cannot be sent to the fleet depot.",
};

/** Format simulated time as the warehouse wall clock (epoch + elapsed), in UTC. */
export function formatSimClock(epochIso: string, simTimeMs: number): string {
  return new Date(Date.parse(epochIso) + simTimeMs).toISOString().slice(11, 19);
}

/** `?scenario=bench-1000` etc. Unknown values are ignored. */
export function scenarioFromSearch(search: string): ScenarioId | null {
  const value = new URLSearchParams(search).get("scenario");
  return value && isScenarioId(value) ? value : null;
}

/** Total stored units and capacity, for KPI chips and empty states. */
export function stockSummary(config: SimulationConfig, inventory: SimulationState["inventory"]) {
  let units = 0;
  let occupied = 0;
  for (const row of Object.values(inventory)) {
    occupied += 1;
    for (const q of Object.values(row)) units += q;
  }
  const capacity = config.locations.reduce((n, l) => n + l.capacity, 0);
  return {
    units,
    capacity,
    occupied,
    locations: config.locations.length,
    utilisation: capacity ? units / capacity : 0,
  };
}

/**
 * Read-only access to the authoritative run for automated tests and tools
 * (`window.__WAREHOUSE_ONE_SIM__`). State is deeply frozen by the runner, so nothing read here
 * can change the simulation.
 */
export interface SimulationDebug {
  state(): SimulationState;
  config(): SimulationConfig;
  commands(): readonly CommandRecord[];
  finishedOrders(): readonly FinishedOrder[];
  /** Authoritative poses of the latest tick (`equipmentPose` / `truckPose`), in metres. */
  poses(): {
    vehicles: { id: string; x: number; z: number; yaw: number; fork: number }[];
    trucks: { id: string; x: number; z: number }[];
    /** Line-haul trucks drawn by the network (null while drawn as a DC truck or off the map). */
    linehaul: { id: string; x: number; z: number; yaw: number }[];
  };
}

declare global {
  interface Window {
    __WAREHOUSE_ONE_SIM__?: Readonly<SimulationDebug>;
  }
}

if (typeof window !== "undefined") {
  window.__WAREHOUSE_ONE_SIM__ = Object.freeze({
    state: () => runner.state,
    config: () => runner.config,
    commands: () => useSimulation.getState().commands,
    finishedOrders: () => useSimulation.getState().finishedOrders,
    poses: () => {
      const ops = runner.state.ops;
      if (!ops) return { vehicles: [], trucks: [], linehaul: [] };
      const net = runner.state.network;
      return {
        linehaul: net
          ? Object.values(net.vehicles).flatMap((v) => {
              const p = linehaulPose(runner.config, runner.state, v);
              return p ? [{ id: v.id, ...p }] : [];
            })
          : [],
        vehicles: vehicleViews(runner.config, undefined, ops, 1).map((v) => ({
          id: v.id,
          ...v.pose,
        })),
        trucks: truckViews(runner.config, undefined, ops, 1).map((t) => ({
          id: t.id,
          x: t.pose.x,
          z: t.pose.z,
        })),
      };
    },
  });
}
