/**
 * Messages between the evaluation pool (main thread) and its workers (Phase 6.1, DEC-042).
 * Both sides validate what they receive: a worker never trusts the page's payload and the pool
 * never trusts a worker's. One message = one job (one trajectory) of one request; every message
 * carries both ids so a late or duplicated message is recognised and dropped.
 *
 * Imports are relative or package names only: this file is bundled into the worker by esbuild.
 */
import { SetStandbyCommand } from "@warehouse-one/contracts";
import { z } from "zod";

/** Upper bounds a worker enforces whatever the page sends (resource limits). */
export const WORKER_LIMITS = {
  horizonTicks: 36_000,
  commandsPerJob: 64,
  /** Ticks between progress messages (and cancellation checks). */
  yieldEvery: 1_000,
} as const;

const Id = z.string().min(1).max(64);

/** Snapshot payload: shape-checked here, integrity (hash, invariants) checked by the worker. */
const SnapshotPayload = z.object({
  config: z.record(z.string(), z.unknown()),
  state: z.record(z.string(), z.unknown()),
  state_hash: z.string().regex(/^[0-9a-f]{32}$/),
});

export const ToWorker = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    requestId: Id,
    jobId: Id,
    snapshot: SnapshotPayload,
    horizon: z.int().min(1).max(WORKER_LIMITS.horizonTicks),
    commands: z.array(SetStandbyCommand).max(WORKER_LIMITS.commandsPerJob),
  }),
  z.object({ type: z.literal("cancel"), requestId: Id }),
]);
export type ToWorker = z.infer<typeof ToWorker>;

const Metrics = z.object({
  pickup_wait_s: z.number().nullable(),
  pickup_wait_p90_s: z.number().nullable(),
  empty_km: z.number(),
  loaded_km: z.number(),
  transfers_planned: z.int(),
  pallets_planned: z.int(),
  transfers_delivered: z.int(),
  pallets_delivered: z.int(),
  transfers_cancelled: z.int(),
  transfers_waiting_end: z.int(),
  lead_time_s: z.number().nullable(),
});

const TrajectoryPayload = z.object({
  metrics: Metrics,
  violations: z.array(z.string()),
  rejections: z.array(
    z.object({ command_id: z.string(), tick: z.int(), code: z.string(), message: z.string() }),
  ),
  end_tick: z.int(),
  end_state_hash: z.string(),
});

export const WORKER_ERRORS = ["INVALID_REQUEST", "INVALID_SNAPSHOT", "SIMULATION_FAILED"] as const;

export const FromWorker = z.discriminatedUnion("type", [
  /** Sent once when the worker has loaded the engine. */
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("progress"), requestId: Id, jobId: Id, ticks: z.int().min(0) }),
  z.object({
    type: z.literal("completed"),
    requestId: Id,
    jobId: Id,
    trajectory: TrajectoryPayload,
  }),
  z.object({ type: z.literal("cancelled"), requestId: Id, jobId: Id }),
  z.object({
    type: z.literal("failed"),
    requestId: z.string().max(64),
    jobId: z.string().max(64),
    code: z.enum(WORKER_ERRORS),
    message: z.string().max(500),
  }),
]);
export type FromWorker = z.infer<typeof FromWorker>;
