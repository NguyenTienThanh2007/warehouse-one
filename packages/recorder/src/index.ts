import type { DomainEvent } from "@warehouse-one/contracts";
import {
  ENGINE_VERSION,
  type LoggedCommand,
  type SimulationConfig,
  type SimulationRunner,
} from "@warehouse-one/simulation";

/**
 * Records one simulation run to the WAREHOUSE ONE API (DEC-024): registers the run's config, then
 * sends its command log and domain events in order, in batches.
 *
 * - Batches never skip ahead: events go in sequence order, and every command applied at a tick is
 *   sent no later than the first batch that reaches that tick (the API closes recorded ticks).
 * - One batch is in flight at a time. A batch keeps its `batch_id` across retries, so a retry after
 *   a lost response is answered from the API's record instead of being stored twice.
 * - Network errors and 5xx responses are retried with bounded exponential backoff. A 4xx response
 *   means the API rejected the data; the recorder stops and reports it instead of retrying.
 */

export type RecorderState = "idle" | "sending" | "retrying" | "failed" | "stopped";

export interface RecorderError {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
}

export interface RecorderStatus {
  readonly state: RecorderState;
  readonly simulationId: string;
  readonly registered: boolean;
  readonly sentEvents: number;
  readonly sentCommands: number;
  readonly pendingEvents: number;
  readonly lastSequence: number;
  readonly throughTick: number;
  readonly attempts: number;
  readonly lastError: RecorderError | null;
}

export interface RecorderOptions {
  readonly apiUrl: string;
  readonly config: SimulationConfig;
  readonly scenarioId?: string | null;
  readonly source: "web" | "recorder";
  readonly maxEventsPerBatch?: number;
  /** Delay before retry n (1-based) is min(baseMs × 2^(n-1), maxMs). */
  readonly retry?: { baseMs: number; maxMs: number; maxAttempts?: number };
  readonly fetch?: typeof fetch;
  readonly newBatchId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onStatus?: (status: RecorderStatus) => void;
}

interface Batch {
  readonly batch_id: string;
  readonly through_tick: number;
  readonly commands: readonly LoggedCommand[];
  readonly events: readonly DomainEvent[];
}

export class RecorderStoppedError extends Error {}

/** API limit is 1,000 events per batch; stay well below it. */
export const DEFAULT_MAX_EVENTS = 500;

export class RunRecorder {
  private readonly events: DomainEvent[] = [];
  private log: () => readonly LoggedCommand[] = () => [];
  private commandsSent = 0;
  private tick = 0;
  private registered = false;
  private state: RecorderState = "idle";
  private sentEvents = 0;
  private lastSequence = 0;
  private throughTick = 0;
  private attempts = 0;
  private lastError: RecorderError | null = null;
  private inFlight: Promise<void> | null = null;
  private pending: Batch | null = null;
  private stopped = false;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retry: { baseMs: number; maxMs: number; maxAttempts: number };

  constructor(private readonly opts: RecorderOptions) {
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retry = {
      baseMs: opts.retry?.baseMs ?? 500,
      maxMs: opts.retry?.maxMs ?? 30_000,
      maxAttempts: opts.retry?.maxAttempts ?? Number.POSITIVE_INFINITY,
    };
  }

  get simulationId(): string {
    return this.opts.config.simulation_id;
  }

  /**
   * Follow a runner from now on: every step's events are queued, and its command log is read as it
   * grows. Attach before the first step so the opening commands and events are recorded too.
   */
  attach(runner: SimulationRunner): () => void {
    if (runner.config.simulation_id !== this.simulationId)
      throw new Error("runner and recorder belong to different runs");
    this.log = () => runner.commandLog;
    this.tick = runner.state.tick;
    return runner.subscribe((result) => {
      this.events.push(...result.events);
      this.tick = result.state.tick;
      this.emit();
    });
  }

  status(): RecorderStatus {
    return {
      state: this.state,
      simulationId: this.simulationId,
      registered: this.registered,
      sentEvents: this.sentEvents,
      sentCommands: this.commandsSent,
      pendingEvents: this.events.length,
      lastSequence: this.lastSequence,
      throughTick: this.throughTick,
      attempts: this.attempts,
      lastError: this.lastError,
    };
  }

  /** Stop sending (in-flight requests finish; nothing further is sent). */
  stop(): void {
    this.stopped = true;
    if (this.state !== "failed") this.state = "stopped";
    this.emit();
  }

  /**
   * Send everything observed so far. Resolves when the API has acknowledged it; rejects when the
   * API rejected data (4xx), the retry budget is exhausted, or the recorder was stopped.
   */
  flush(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.drain().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    if (this.state === "failed") throw this.failure();
    if (!this.registered) await this.send("PUT", this.runPath(), this.registration(), "register");
    this.registered = true;
    for (;;) {
      const batch = this.pending ?? this.nextBatch();
      if (!batch) break;
      this.pending = batch;
      await this.send("POST", `${this.runPath()}/batches`, batch, "batch");
      this.pending = null;
      this.events.splice(0, batch.events.length);
      this.commandsSent += batch.commands.length;
      this.sentEvents += batch.events.length;
      this.lastSequence = batch.events.at(-1)?.sequence ?? this.lastSequence;
      this.throughTick = batch.through_tick;
    }
    if (this.state === "sending" || this.state === "retrying") this.state = "idle";
    this.emit();
  }

  /** The next batch, or null when nothing new has happened since the last one. */
  private nextBatch(): Batch | null {
    const max = this.opts.maxEventsPerBatch ?? DEFAULT_MAX_EVENTS;
    const events = this.events.slice(0, max);
    const last = events.at(-1);
    // A partial queue ends at its last event's tick; a drained queue covers every observed tick.
    const tickMs = this.opts.config.tick_ms;
    const through =
      events.length < this.events.length && last ? last.simulation_time_ms / tickMs : this.tick;
    const log = this.log();
    let end = this.commandsSent;
    while (end < log.length && (log[end]?.tick ?? Infinity) <= through) end++;
    const commands = log.slice(this.commandsSent, end);
    if (events.length === 0 && commands.length === 0 && through <= this.throughTick) return null;
    return {
      batch_id: this.opts.newBatchId?.() ?? crypto.randomUUID(),
      through_tick: through,
      commands,
      events,
    };
  }

  private registration() {
    return {
      config: this.opts.config,
      engine_version: ENGINE_VERSION,
      scenario_id: this.opts.scenarioId ?? null,
      source: this.opts.source,
    };
  }

  private runPath(): string {
    return `${this.opts.apiUrl.replace(/\/$/, "")}/api/v1/simulations/${this.simulationId}`;
  }

  private async send(method: "PUT" | "POST", url: string, body: unknown, what: string) {
    const payload = JSON.stringify(body);
    for (let attempt = 1; ; attempt++) {
      if (this.stopped) throw new RecorderStoppedError("recorder stopped");
      this.state = attempt === 1 ? "sending" : "retrying";
      this.attempts = attempt;
      this.emit();
      let status = 0;
      let detail: RecorderError;
      try {
        const res = await this.fetchFn(url, {
          method,
          headers: { "content-type": "application/json" },
          body: payload,
        });
        status = res.status;
        if (res.ok) {
          this.attempts = 0;
          this.lastError = null;
          return;
        }
        detail = await errorOf(res, what);
      } catch (err) {
        detail = { code: "NETWORK", message: err instanceof Error ? err.message : String(err) };
      }
      this.lastError = detail;
      if (status >= 400 && status < 500) {
        this.state = "failed";
        this.emit();
        throw this.failure();
      }
      if (attempt >= this.retry.maxAttempts) {
        this.state = "failed";
        this.emit();
        throw this.failure();
      }
      await this.sleep(Math.min(this.retry.baseMs * 2 ** (attempt - 1), this.retry.maxMs));
    }
  }

  private failure(): Error {
    const e = this.lastError;
    return new Error(e ? `${e.code}: ${e.message}` : "recorder failed");
  }

  private emit(): void {
    this.opts.onStatus?.(this.status());
  }
}

async function errorOf(res: Response, what: string): Promise<RecorderError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return {
      code: body.error?.code ?? `HTTP_${res.status}`,
      message: body.error?.message ?? `${what} failed`,
      status: res.status,
    };
  } catch {
    return { code: `HTTP_${res.status}`, message: `${what} failed`, status: res.status };
  }
}

/** A copy of a scenario config with a fresh run identity, for recording a new session. */
export function withFreshRunId(
  config: SimulationConfig,
  id: string = crypto.randomUUID(),
): SimulationConfig {
  return { ...config, simulation_id: id };
}

export { checkReplay, type ReplayCheck } from "./verify";
