import { describe, expect, it } from "vitest";
import { FrameStats } from "./frame-stats";

describe("FrameStats", () => {
  it("returns null before any frames", () => {
    expect(new FrameStats().summary()).toBeNull();
  });

  it("computes fps and percentiles for a steady 60 FPS stream", () => {
    const s = new FrameStats(100);
    for (let i = 0; i < 100; i++) s.record(1000 / 60);
    const r = s.summary()!;
    expect(r.fps).toBeCloseTo(60, 5);
    expect(r.p95Ms).toBeCloseTo(16.667, 2);
    expect(r.longFrames).toBe(0);
  });

  it("reports spikes in tail percentiles and long-frame count", () => {
    const s = new FrameStats(100);
    for (let i = 0; i < 95; i++) s.record(10);
    for (let i = 0; i < 5; i++) s.record(50);
    const r = s.summary()!;
    expect(r.p50Ms).toBe(10);
    expect(r.p95Ms).toBe(10);
    expect(r.p99Ms).toBe(50);
    expect(r.maxMs).toBe(50);
    expect(r.longFrames).toBe(5);
  });

  it("keeps only the most recent window", () => {
    const s = new FrameStats(4);
    [100, 100, 100, 100, 10, 10, 10, 10].forEach((v) => s.record(v));
    expect(s.summary()!.maxMs).toBe(10);
    expect(s.summary()!.samples).toBe(4);
  });

  it("ignores invalid samples", () => {
    const s = new FrameStats();
    [0, -5, Number.NaN, Number.POSITIVE_INFINITY].forEach((v) => s.record(v));
    expect(s.summary()).toBeNull();
  });
});
