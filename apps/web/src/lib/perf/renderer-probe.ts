"use client";

import { FrameStats, type FrameSummary } from "./frame-stats";

export interface RendererInfo {
  drawCalls: number;
  triangles: number;
  dpr: number;
}

/** Shared, non-reactive renderer metrics (written every frame, read by the panel a few times/sec). */
export const frameStats = new FrameStats(240);
export const rendererInfo: RendererInfo = { drawCalls: 0, triangles: 0, dpr: 1 };

declare global {
  interface Window {
    /** Hook for automated browser benchmarks (tests/performance). Read-only metrics. */
    __WAREHOUSE_ONE_PERF__?: {
      summary(): FrameSummary | null;
      reset(): void;
      renderer(): RendererInfo;
    };
  }
}

export function exposePerfHook(): void {
  if (typeof window === "undefined") return;
  window.__WAREHOUSE_ONE_PERF__ = {
    summary: () => frameStats.summary(),
    reset: () => frameStats.reset(),
    renderer: () => ({ ...rendererInfo }),
  };
}
