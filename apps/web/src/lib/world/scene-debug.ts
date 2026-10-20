"use client";

import type { SceneCounts } from "../../world/derive";

/**
 * Read-only scene introspection for automated tests and benchmarks
 * (`window.__WAREHOUSE_ONE_SCENE__`). It reports what is rendered so tests can compare it with
 * authoritative simulation state; it cannot change anything.
 */
export interface SceneDebug {
  counts?: SceneCounts;
  pickables?: { kind: string; id: string; center: [number, number, number] }[];
  camera?: { position: [number, number, number]; target: [number, number, number] };
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
