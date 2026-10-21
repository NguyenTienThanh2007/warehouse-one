"use client";

import { useEffect } from "react";
import { useSimulation } from "./store";

/** Max real time fed to the simulation per call; a backgrounded tab must not cause a burst. */
const MAX_FRAME_DELTA_MS = 250;
/** Timer cadence that keeps the simulation at its requested speed when frames are slow. */
const TIMER_INTERVAL_MS = 50;

/**
 * Feeds real elapsed time to the fixed-step simulation, independent of the renderer's frame rate.
 *
 * Time is fed from requestAnimationFrame (smooth at normal frame rates) and from a 50 ms timer,
 * both drawing on one clock, so every millisecond is fed exactly once. Without the timer, a slow
 * renderer (software WebGL at a few frames per second) throttled the simulation: each frame is
 * capped at 250 ms, so at 2 FPS an 8× run advanced at 4× (DEC-023). The cap still applies per call,
 * so a backgrounded tab (timers throttled to ~1 Hz, no frames) cannot cause a catch-up burst.
 */
export function createSimulationClock(
  advance: (realDeltaMs: number) => void,
  start: number,
): (now: number) => void {
  let last = start;
  return (now) => {
    const delta = now - last;
    if (delta <= 0) return;
    last = now;
    advance(Math.min(delta, MAX_FRAME_DELTA_MS));
  };
}

export function useSimulationLoop(autoStart = true): void {
  useEffect(() => {
    const { advance, togglePause, paused } = useSimulation.getState();
    if (autoStart && paused) togglePause();
    const feed = createSimulationClock(advance, performance.now());
    let frame = requestAnimationFrame(function loop(now) {
      feed(now);
      frame = requestAnimationFrame(loop);
    });
    const timer = setInterval(() => feed(performance.now()), TIMER_INTERVAL_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
    };
  }, [autoStart]);
}
