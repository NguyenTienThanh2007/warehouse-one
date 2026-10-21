"use client";

import type { DomainEvent } from "@warehouse-one/contracts";
import { formatSimClock, SPEED_PRESETS, useSimulation } from "@/lib/sim/store";

const EVENT_LABEL: Record<DomainEvent["event_type"], string> = {
  "inventory.received": "Received",
  "inventory.moved": "Moved",
  "inventory.adjusted": "Adjusted",
  "pallet.created": "Pallet",
  "pallet.moved": "Pallet",
  "pallet.removed": "Pallet",
  "task.created": "Task",
  "task.assigned": "Assigned",
  "task.completed": "Done",
  "task.cancelled": "Cancelled",
  "equipment.status_changed": "Vehicle",
  "truck.status_changed": "Truck",
  "order.status_changed": "Order",
};

type Position = Extract<DomainEvent, { event_type: "pallet.moved" }>["payload"]["from"];
function where(p: Position): string {
  switch (p.kind) {
    case "slot":
      return `${p.location_id}#${p.slot}`;
    case "staging":
      return `${p.dock_id} lane ${p.position}`;
    case "equipment":
      return p.equipment_id;
    case "truck":
      return p.truck_id;
  }
}

function describe(e: DomainEvent): string {
  switch (e.event_type) {
    case "inventory.received":
      return `${e.payload.quantity} × ${e.payload.sku} → ${e.payload.location_id}`;
    case "inventory.moved":
      return `${e.payload.quantity} × ${e.payload.sku} ${e.payload.from_location_id} → ${e.payload.to_location_id}`;
    case "inventory.adjusted":
      return `${e.payload.delta > 0 ? "+" : ""}${e.payload.delta} ${e.payload.sku} @ ${e.payload.location_id} (${e.payload.reason})`;
    case "pallet.created":
      return `${e.payload.pallet_id} created at ${where(e.payload.at)}`;
    case "pallet.moved":
      return `${e.payload.pallet_id} ${where(e.payload.from)} → ${where(e.payload.to)}`;
    case "pallet.removed":
      return `${e.payload.pallet_id} ${e.payload.reason}`;
    case "task.created":
      return `${e.payload.task_id} ${e.payload.task_type} ${e.payload.pallet_id}`;
    case "task.assigned":
      return `${e.payload.task_id} → ${e.payload.equipment_id}`;
    case "task.completed":
      return `${e.payload.task_id} by ${e.payload.equipment_id}`;
    case "task.cancelled":
      return `${e.payload.task_id} (${e.payload.reason})`;
    case "equipment.status_changed":
      return `${e.payload.equipment_id} ${e.payload.from} → ${e.payload.to}`;
    case "truck.status_changed":
      return `${e.payload.truck_id} ${e.payload.from ?? "new"} → ${e.payload.to}`;
    case "order.status_changed":
      return `${e.payload.order_id} ${e.payload.from ?? "new"} → ${e.payload.to}`;
  }
}

export function SimulationPanel() {
  const s = useSimulation();

  return (
    <section
      aria-labelledby="sim-title"
      className="panel pointer-events-auto w-full p-3 sm:w-[380px] sm:p-4"
      data-testid="simulation-panel"
    >
      <div className="flex items-center justify-between">
        <h2 id="sim-title" className="panel-title">
          Simulation engine
        </h2>
        <span
          className={`flex items-center gap-1.5 text-[11px] ${s.paused ? "text-fog-400" : "text-data-300"}`}
        >
          <span
            className={`size-1.5 rounded-full ${s.paused ? "bg-fog-500" : "animate-pulse bg-data-400"}`}
          />
          {s.paused ? "Paused" : "Running"}
        </span>
      </div>

      <div className="mt-3 flex items-end justify-between">
        <div>
          <p className="hidden text-[11px] text-fog-400 sm:block">Simulated clock (UTC)</p>
          <p
            className="metric text-2xl font-medium tracking-tight sm:text-3xl"
            data-testid="sim-clock"
          >
            {formatSimClock(s.config.epoch, s.simTimeMs)}
          </p>
        </div>
        <dl className="metric hidden grid-cols-2 gap-x-4 gap-y-0.5 text-right text-xs sm:grid">
          <dt className="text-fog-500">tick</dt>
          <dd data-testid="sim-tick">{s.tick.toLocaleString("en-US")}</dd>
          <dt className="text-fog-500">events</dt>
          <dd data-testid="sim-events">{s.eventCount.toLocaleString("en-US")}</dd>
          <dt className="text-fog-500">rejected</dt>
          <dd>{s.rejectionCount}</dd>
        </dl>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={s.togglePause}
          aria-label={s.paused ? "Resume simulation (Space)" : "Pause simulation (Space)"}
          data-testid="sim-toggle"
          className="rounded-lg bg-signal-400 px-3 py-1.5 text-xs font-semibold text-ink-950 transition hover:bg-signal-300"
        >
          {s.paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={s.stepOnce}
          disabled={!s.paused}
          aria-label="Advance one tick (.)"
          className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-fog-200 transition hover:bg-white/5 disabled:opacity-40"
        >
          Step
        </button>
        <div
          role="group"
          aria-label="Simulation speed"
          className="ml-auto flex rounded-lg border border-white/10 p-0.5"
        >
          {SPEED_PRESETS.map((v, i) => (
            <button
              key={v}
              type="button"
              aria-pressed={s.speed === v}
              title={`${v}× speed (${i + 1})`}
              onClick={() => s.setSpeed(v)}
              className={`metric rounded-md px-2 py-1 text-[11px] transition ${
                s.speed === v ? "bg-ink-700 text-fog-50" : "text-fog-400 hover:text-fog-200"
              }`}
            >
              {v}×
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 hidden sm:block">
        <h3 className="panel-title">Event stream</h3>
        <ol className="mt-2 space-y-1" aria-live="off" data-testid="event-feed">
          {s.recentEvents.length === 0 ? (
            <li className="text-xs text-fog-500">Waiting for the first domain event…</li>
          ) : (
            s.recentEvents.map((e) => (
              <li key={e.event_id} className="flex gap-2 text-[11px] leading-5">
                <span className="metric w-10 shrink-0 text-fog-500">#{e.sequence}</span>
                <span className="w-16 shrink-0 text-data-300">{EVENT_LABEL[e.event_type]}</span>
                <span className="truncate text-fog-200">{describe(e)}</span>
              </li>
            ))
          )}
        </ol>
      </div>

      <div className="mt-3 hidden items-center justify-between border-t border-white/5 pt-2.5 text-[11px] text-fog-500 sm:flex">
        <span title="Fingerprint of the authoritative state; identical seeds and commands give identical hashes">
          state <span className="metric text-fog-400">{s.stateHash.slice(0, 12)}</span>
        </span>
        <button
          type="button"
          onClick={s.reset}
          className="text-fog-400 underline-offset-2 hover:text-fog-200 hover:underline"
        >
          Reset run
        </button>
      </div>
    </section>
  );
}
