"use client";

import type { DomainEvent } from "@warehouse-one/contracts";
import {
  createFoundationDemoConfig,
  SimulationRunner,
  stateHash,
  type SimulationConfig,
  type SimulationState,
} from "@warehouse-one/simulation";
import { create } from "zustand";

/**
 * UI-facing projection of the authoritative simulation. Components read from here; only the
 * actions below talk to the runner, and the runner publishes deeply frozen state, so rendering
 * can never alter business state.
 */
export interface SimulationView {
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
  readonly selectedLocationId: string | null;
}

interface SimulationActions {
  advance(realDeltaMs: number): void;
  togglePause(): void;
  setSpeed(factor: number): void;
  stepOnce(): void;
  reset(): void;
  select(locationId: string | null): void;
  /** Replace the running scenario (e.g. a larger layout for benchmarks). Starts a fresh run. */
  loadScenario(config: SimulationConfig): void;
}

export const SPEED_PRESETS = [0.5, 1, 2, 4, 8] as const;
const RECENT_EVENTS = 6;

let runner = new SimulationRunner(createFoundationDemoConfig());

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
    config: runner.config,
    ...project(runner),
    eventCount: 0,
    rejectionCount: 0,
    recentEvents: [],
    selectedLocationId: null,

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
      get().loadScenario(runner.config);
    },
    select(locationId) {
      set({ selectedLocationId: locationId });
    },
    loadScenario(config) {
      const wasPaused = runner.paused;
      runner = new SimulationRunner(config);
      runner.setSpeed(get().speed);
      if (!wasPaused) runner.resume();
      set({
        config,
        ...project(runner),
        eventCount: 0,
        rejectionCount: 0,
        recentEvents: [],
        selectedLocationId: null,
      });
    },
  };
});

/** Format simulated time as the warehouse wall clock (epoch + elapsed), in UTC. */
export function formatSimClock(epochIso: string, simTimeMs: number): string {
  return new Date(Date.parse(epochIso) + simTimeMs).toISOString().slice(11, 19);
}

/**
 * Layout size from the URL (`?aisles=10&bays=100`) for benchmark scenes. Values are clamped;
 * anything invalid falls back to the default demo layout.
 */
export function layoutFromSearch(search: string): { aisles: number; bays: number } | null {
  const params = new URLSearchParams(search);
  const aisles = Number(params.get("aisles"));
  const bays = Number(params.get("bays"));
  if (!Number.isInteger(aisles) || !Number.isInteger(bays) || aisles < 1 || bays < 1) return null;
  return { aisles: Math.min(aisles, 20), bays: Math.min(bays, 100) };
}
