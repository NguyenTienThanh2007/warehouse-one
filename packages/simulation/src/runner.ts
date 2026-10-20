import type { DomainEvent } from "@warehouse-one/contracts";
import { parseCommand } from "@warehouse-one/contracts";
import { createInitialState, step } from "./engine";
import { createSnapshot, type Snapshot } from "./snapshot";
import type { CommandRejection, LoggedCommand, SimulationConfig, SimulationState, StepResult } from "./types";

export const SPEED_LIMITS = { min: 0.25, max: 16 } as const;

export interface RunnerOptions {
  /** Upper bound on ticks per `advance()` call; protects the frame from a catch-up spiral. */
  readonly maxTicksPerAdvance?: number;
  /** Deep-freeze published state so accidental mutation (e.g. by a renderer) throws. Default true. */
  readonly freezeState?: boolean;
}

export interface AdvanceSummary {
  readonly ticks: number;
  readonly events: readonly DomainEvent[];
  readonly rejections: readonly CommandRejection[];
  /** Simulated milliseconds discarded because the tick budget was exhausted. */
  readonly droppedMs: number;
}

export type SubmitResult = { accepted: true } | { accepted: false; issues: string[] };
type Listener = (result: StepResult) => void;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Imperative shell around the pure engine. Owns the fixed-step accumulator, pause/speed controls,
 * the pending command queue and the authoritative command log. The caller supplies real elapsed
 * time, so the runner itself never reads a clock and stays testable.
 */
export class SimulationRunner {
  private current: SimulationState;
  private pending: LoggedCommand["command"][] = [];
  private readonly log: LoggedCommand[] = [];
  private readonly listeners = new Set<Listener>();
  private accumulatorMs = 0;
  private isPaused = true;
  private speedFactor = 1;
  private readonly maxTicks: number;
  private readonly freeze: boolean;

  constructor(
    readonly config: SimulationConfig,
    options: RunnerOptions = {},
    initial?: { state: SimulationState; log?: readonly LoggedCommand[] },
  ) {
    this.maxTicks = options.maxTicksPerAdvance ?? 240;
    this.freeze = options.freezeState ?? true;
    this.current = this.publish(initial?.state ?? createInitialState(config));
    if (initial?.log) this.log.push(...initial.log);
  }

  static fromSnapshot(snapshot: Snapshot, options?: RunnerOptions): SimulationRunner {
    return new SimulationRunner(snapshot.config, options, { state: snapshot.state });
  }

  get state(): SimulationState {
    return this.current;
  }
  get paused(): boolean {
    return this.isPaused;
  }
  get speed(): number {
    return this.speedFactor;
  }
  get commandLog(): readonly LoggedCommand[] {
    return this.log;
  }
  get simulationTimeMs(): number {
    return this.current.tick * this.config.tick_ms;
  }

  pause(): void {
    this.isPaused = true;
    this.accumulatorMs = 0;
  }
  resume(): void {
    this.isPaused = false;
  }
  setSpeed(factor: number): void {
    if (!Number.isFinite(factor) || factor < SPEED_LIMITS.min || factor > SPEED_LIMITS.max) {
      throw new RangeError(`speed must be within [${SPEED_LIMITS.min}, ${SPEED_LIMITS.max}]`);
    }
    this.speedFactor = factor;
  }

  /** Queue a command for the next tick. Schema-invalid input is rejected immediately. */
  submit(input: unknown): SubmitResult {
    const parsed = parseCommand(input);
    if (!parsed.ok) return { accepted: false, issues: parsed.issues };
    this.pending.push(parsed.value);
    return { accepted: true };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Execute exactly one tick regardless of pause state (single-step debugging, tests, replay tools). */
  stepOnce(): StepResult {
    const commands = this.pending;
    this.pending = [];
    const result = step(this.config, this.current, commands);
    for (const command of commands) this.log.push({ tick: result.state.tick, command });
    this.current = this.publish(result.state);
    for (const l of this.listeners) l(result);
    return result;
  }

  /** Feed real elapsed time; runs as many fixed ticks as the accumulator allows. */
  advance(realDeltaMs: number): AdvanceSummary {
    if (this.isPaused || !(realDeltaMs > 0)) return { ticks: 0, events: [], rejections: [], droppedMs: 0 };
    this.accumulatorMs += realDeltaMs * this.speedFactor;
    const events: DomainEvent[] = [];
    const rejections: CommandRejection[] = [];
    let ticks = 0;
    while (this.accumulatorMs >= this.config.tick_ms && ticks < this.maxTicks) {
      const r = this.stepOnce();
      events.push(...r.events);
      rejections.push(...r.rejections);
      this.accumulatorMs -= this.config.tick_ms;
      ticks++;
    }
    let droppedMs = 0;
    if (this.accumulatorMs >= this.config.tick_ms) {
      droppedMs = this.accumulatorMs - (this.accumulatorMs % this.config.tick_ms);
      this.accumulatorMs %= this.config.tick_ms;
    }
    return { ticks, events, rejections, droppedMs };
  }

  snapshot(): Snapshot {
    return createSnapshot(this.config, this.current);
  }

  private publish(state: SimulationState): SimulationState {
    return this.freeze ? deepFreeze(state) : state;
  }
}
