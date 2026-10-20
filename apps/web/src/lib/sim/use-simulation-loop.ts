"use client";

import { useEffect } from "react";
import { useSimulation } from "./store";

/** Max real time fed to the simulation per frame; a backgrounded tab must not cause a burst. */
const MAX_FRAME_DELTA_MS = 250;

/** Drives the fixed-step simulation from requestAnimationFrame, independent of the renderer. */
export function useSimulationLoop(autoStart = true): void {
  useEffect(() => {
    const { advance, togglePause, paused } = useSimulation.getState();
    if (autoStart && paused) togglePause();
    let last = performance.now();
    let frame = requestAnimationFrame(function loop(now) {
      advance(Math.min(now - last, MAX_FRAME_DELTA_MS));
      last = now;
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [autoStart]);
}
