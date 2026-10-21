"use client";

import type { SceneCounts } from "../../world/derive";

export interface DebugPickable {
  kind: string;
  id: string;
  center: [number, number, number];
}

/** What the moving layer drew in the last frame (rounded to millimetres). */
export interface MovingDebug {
  vehicles: { id: string; x: number; z: number; yaw: number; fork: number }[];
  trucks: { id: string; x: number; z: number }[];
  carried: { id: string; x: number; y: number; z: number }[];
  /** Pick volumes of vehicles and trucks, which follow them every frame. */
  pickables: DebugPickable[];
}

/**
 * Read-only scene introspection for automated tests and benchmarks
 * (`window.__WAREHOUSE_ONE_SCENE__`). It reports what is rendered so tests can compare it with
 * authoritative simulation state; it cannot change anything.
 */
export interface SceneDebug {
  counts?: SceneCounts;
  /** Static pick volumes: rack bays and docks. */
  pickables?: DebugPickable[];
  moving?: MovingDebug;
  camera?: { position: [number, number, number]; target: [number, number, number] };
  /**
   * Camera motion from camera-controls events: `moving` between 'wake' and 'rest'; `rests` counts
   * rest events. `camera` is republished exactly at each rest, so a waiter can read a settled pose.
   */
  cameraMotion?: { moving: boolean; rests: number };
  /** Line-haul trucks drawn in the last frame (metres, rounded to millimetres). */
  fleet?: { id: string; x: number; z: number }[];
  /** Phase 5 network layer: sites, and what is drawn from `state.network`. */
  network?: {
    sites: {
      id: string;
      kind: string;
      center: [number, number, number];
      bounds: { min: { x: number; z: number }; max: { x: number; z: number } };
    }[];
    buildings: number;
    roads: number;
    containers: Record<string, number>;
    floorPallets: Record<string, number>;
    linehaulDrawn: string[];
  };
  /** Pickable centres projected to normalised screen coordinates (x, y in [-1, 1] when visible). */
  projected?: { kind: string; id: string; x: number; y: number; visible: boolean }[];
}

const state: SceneDebug = {};

declare global {
  interface Window {
    __WAREHOUSE_ONE_SCENE__?: Readonly<SceneDebug>;
  }
}

export function publishSceneDebug(patch: Partial<SceneDebug>): void {
  Object.assign(state, patch);
  if (typeof window !== "undefined") window.__WAREHOUSE_ONE_SCENE__ = state;
}
