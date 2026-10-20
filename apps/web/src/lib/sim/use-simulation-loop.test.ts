import { describe, expect, it } from "vitest";
import { createSimulationClock } from "./use-simulation-loop";

describe("simulation clock (frames and timer share one clock)", () => {
  const run = (calls: number[]) => {
    const fed: number[] = [];
    const feed = createSimulationClock((ms) => fed.push(ms), 0);
    for (const t of calls) feed(t);
    return fed;
  };

  it("feeds every millisecond exactly once, whichever source calls", () => {
    // Frames at 16.7 ms interleaved with 50 ms timer ticks.
    const fed = run([16.7, 33.4, 50, 50.1, 66.8, 100]);
    expect(fed.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it("keeps real time when frames are slow (software WebGL at ~2 FPS)", () => {
    // One frame every 500 ms; the timer fires every 50 ms in between.
    const calls: number[] = [];
    for (let t = 50; t <= 2000; t += 50) calls.push(t);
    const fed = run(calls);
    expect(fed.reduce((a, b) => a + b, 0)).toBe(2000);
    // Frames alone would have been capped at 250 ms each: 4 frames → 1,000 ms of 2,000.
    expect(run([500, 1000, 1500, 2000]).reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it("caps each call at 250 ms, so a backgrounded tab cannot cause a burst", () => {
    expect(run([10_000])).toEqual([250]);
  });

  it("ignores out-of-order timestamps (a frame stamped before the last timer call)", () => {
    expect(run([100, 90, 120])).toEqual([100, 20]);
  });
});
