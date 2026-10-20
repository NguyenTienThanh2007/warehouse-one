/**
 * Rolling frame-time statistics for the renderer. Pure data structure (no DOM, no clock), so it is
 * unit-tested and reused by the in-app performance panel and by automated browser benchmarks.
 */
export interface FrameSummary {
  /** Number of frames in the window. */
  readonly samples: number;
  readonly fps: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** Frames slower than 1.5x the 60 FPS budget (25 ms). */
  readonly longFrames: number;
}

export const LONG_FRAME_MS = 25;

export class FrameStats {
  private readonly buffer: Float64Array;
  private count = 0;
  private head = 0;

  constructor(readonly capacity = 240) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new RangeError("capacity must be >= 2");
    this.buffer = new Float64Array(capacity);
  }

  record(frameMs: number): void {
    if (!(frameMs > 0) || !Number.isFinite(frameMs)) return;
    this.buffer[this.head] = frameMs;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
  }

  summary(): FrameSummary | null {
    if (this.count === 0) return null;
    const values = Array.from(this.buffer.subarray(0, this.count)).sort((a, b) => a - b);
    const total = values.reduce((s, v) => s + v, 0);
    const pct = (p: number) =>
      values[Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1)] ?? 0;
    return {
      samples: this.count,
      fps: 1000 / (total / this.count),
      meanMs: total / this.count,
      p50Ms: pct(50),
      p95Ms: pct(95),
      p99Ms: pct(99),
      maxMs: values[values.length - 1] ?? 0,
      longFrames: values.filter((v) => v > LONG_FRAME_MS).length,
    };
  }
}
