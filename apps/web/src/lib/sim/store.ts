"use client";

import type { DomainEvent } from "@warehouse-one/contracts";
import {
  createScenario,
  isScenarioId,
  SimulationRunner,
  stateHash,
  type Scenario,
  type ScenarioId,
  type SimulationConfig,
  type SimulationState,
} from "@warehouse-one/simulation";
import { create } from "zustand";

/** What the user has selected in the world. IDs always refer to config/state entities. */
export type Selection =
  | { readonly kind: "location"; readonly id: string }
  | { readonly kind: "equipment"; readonly id: string }
  | { readonly kind: "dock"; readonly id: string };

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
  readonly stateHash: string;
  readonly selection: Selection | null;
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
}

export const SPEED_PRESETS = [0.5, 1, 2, 4, 8] as const;
export const DEFAULT_SCENARIO: ScenarioId = "showcase";
const RECENT_EVENTS = 6;

interface Started {
  runner: SimulationRunner;
  events: readonly DomainEvent[];
  rejections: number;
}

/** Opening stock goes through submit + step like any command: logged, validated, replayable. */
function start(scenario: Scenario): Started {
  const runner = new SimulationRunner(scenario.config);
  if (scenario.openingCommands.length === 0) return { runner, events: [], rejections: 0 };
  for (const c of scenario.openingCommands) runner.submit(c);
  const r = runner.stepOnce();
  return { runner, events: r.events, rejections: r.rejections.length };
}

const initial = start(createScenario(DEFAULT_SCENARIO));
let runner = initial.runner;
const recent = (events: readonly DomainEvent[]) => [...events.slice(-RECENT_EVENTS)].reverse();

function project(
  r: SimulationRunner,
): Pick<SimulationView, "tick" | "simTimeMs" | "paused" | "speed" | "inventory" | "stateHash"> {
  return {
    tick: r.state.tick,
    simTimeMs: r.simulationTimeMs,
    paused: r.paused,
    speed: r.speed,
    inventory: r.state.inventory,
    stateHash: stateHash(r.config, r.state),
  };
}

export const useSimulation = create<SimulationView & SimulationActions>()((set, get) => {
  const absorb = (events: readonly DomainEvent[], rejections: number) => {
    const s = get();
    set({
      ...project(runner),
      eventCount: s.eventCount + events.length,
      rejectionCount: s.rejectionCount + rejections,
      recentEvents: events.length
        ? [...events.slice(-RECENT_EVENTS).reverse(), ...s.recentEvents].slice(0, RECENT_EVENTS)
        : s.recentEvents,
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

    advance(realDeltaMs) {
      const r = runner.advance(realDeltaMs);
      if (r.ticks > 0) absorb(r.events, r.rejections.length);
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
      absorb(r.events, r.rejections.length);
    },
    reset() {
      get().loadScenario(get().scenarioId);
    },
    select(selection) {
      set({ selection });
    },
    loadScenario(id) {
      const wasPaused = runner.paused;
      const started = start(createScenario(id));
      runner = started.runner;
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
      });
    },
  };
});

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
