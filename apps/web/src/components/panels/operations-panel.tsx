"use client";

import type { CargoLine } from "@warehouse-one/contracts";
import type { OperationsState, SimulationConfig, TaskState } from "@warehouse-one/simulation";
import { useMemo, useState } from "react";
import { useSimulation, type Selection } from "@/lib/sim/store";
import { describePosition, freeStock, opsSummary } from "@/world/ops-view";
import { CommandFeedback } from "./command-feedback";
import { formatTicks } from "./format";

/**
 * Operator view of the running operation: the task queue, orders, trucks and docks, and forms that
 * submit real commands (outbound orders, inbound trucks). Everything shown is read from
 * `state.ops` or from the event stream; nothing is estimated.
 */

const TABS = [
  { id: "tasks", label: "Tasks" },
  { id: "orders", label: "Orders" },
  { id: "trucks", label: "Trucks" },
  { id: "new", label: "New work" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const TASK_STATUS_LABEL: Record<TaskState["status"], string> = {
  pending: "Waiting",
  assigned: "To pick-up",
  picking: "Picking",
  carrying: "Carrying",
  dropping: "Dropping",
};

const input = "w-full rounded-md bg-ink-800 px-2 py-1.5 text-xs text-fog-50";
const button =
  "rounded-md bg-signal-400 px-2.5 py-1 text-[11px] font-semibold text-ink-950 transition hover:bg-signal-300 disabled:opacity-40";

function Link({ selection, children }: { selection: Selection; children: React.ReactNode }) {
  const select = useSimulation((s) => s.select);
  return (
    <button
      type="button"
      className="metric text-fog-200 underline-offset-2 hover:underline"
      onClick={() => select(selection)}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-xs text-fog-500">{children}</p>;
}

// Tasks ----------------------------------------------------------------------------------------

function TaskQueue({ config, ops }: { config: SimulationConfig; ops: OperationsState }) {
  const tick = useSimulation((s) => s.tick);
  const tasks = Object.values(ops.tasks).sort((a, b) => a.id.localeCompare(b.id));
  const summary = opsSummary(ops);
  return (
    <div>
      <p className="text-[11px] text-fog-400" data-testid="task-summary">
        {summary.tasks} open · {summary.tasksByStatus.pending} waiting · {summary.vehiclesBusy}/
        {summary.vehicles} vehicles busy
      </p>
      {tasks.length === 0 ? (
        <Empty>No open tasks. Vehicles are idle or charging.</Empty>
      ) : (
        <ol className="mt-2 space-y-1">
          {tasks.slice(0, 30).map((t) => (
            <li
              key={t.id}
              className="rounded-md bg-ink-800/70 px-2 py-1.5 text-[11px] leading-4"
              data-testid="task-row"
              data-task-id={t.id}
              data-status={t.status}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="metric text-fog-50">
                  {t.id} <span className="text-data-300">{t.type}</span>
                </span>
                <span className="text-fog-400">
                  {TASK_STATUS_LABEL[t.status]} · {formatTicks(config, tick - t.created_tick)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-fog-400">
                {t.pallet_id} ({t.sku}) · {describePosition(t.from)} → {describePosition(t.to)}
              </p>
              <p className="text-fog-500">
                {t.equipment_id ? (
                  <Link selection={{ kind: "equipment", id: t.equipment_id }}>
                    {t.equipment_id}
                  </Link>
                ) : (
                  "Unassigned"
                )}
                {t.order_id ? ` · ${t.order_id}` : ""}
                {t.truck_id ? ` · ${t.truck_id}` : ""}
              </p>
            </li>
          ))}
          {tasks.length > 30 && (
            <li className="text-[11px] text-fog-500">+{tasks.length - 30} more</li>
          )}
        </ol>
      )}
    </div>
  );
}

// Orders ---------------------------------------------------------------------------------------

function Orders({ ops }: { ops: OperationsState }) {
  const submit = useSimulation((s) => s.submitCommand);
  const finished = useSimulation((s) => s.finishedOrders);
  const orders = Object.values(ops.orders).sort((a, b) => a.id.localeCompare(b.id));
  return (
    <div>
      {orders.length === 0 ? (
        <Empty>No open orders. Create one under “New work”.</Empty>
      ) : (
        <ol className="space-y-1">
          {orders.map((o) => {
            const loaded = o.pallet_ids.filter((id) => ops.pallets[id]?.at.kind === "truck").length;
            const staged = o.pallet_ids.filter(
              (id) => ops.pallets[id]?.at.kind === "staging",
            ).length;
            return (
              <li
                key={o.id}
                className="rounded-md bg-ink-800/70 px-2 py-1.5 text-[11px] leading-4"
                data-testid="order-row"
                data-order-id={o.id}
                data-status={o.status}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="metric text-fog-50">{o.id}</span>
                  <span className="text-data-300">{o.status.replace("_", " ")}</span>
                </div>
                <p className="mt-0.5 truncate text-fog-400">
                  {o.lines.map((l) => `${l.quantity} × ${l.sku}`).join(", ")}
                </p>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-fog-500">
                  <span>
                    <Link selection={{ kind: "truck", id: o.truck_id }}>{o.truck_id}</Link> ·{" "}
                    <span className="metric">
                      {loaded}/{o.pallet_ids.length}
                    </span>{" "}
                    loaded{staged ? ` · ${staged} staged` : ""}
                  </span>
                  {o.status === "open" && (
                    <button
                      type="button"
                      className="text-fog-400 underline-offset-2 hover:text-fog-200 hover:underline"
                      onClick={() => submit({ type: "order.cancel", payload: { order_id: o.id } })}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {finished.length > 0 && (
        <>
          <h3 className="panel-title mt-3">Recently finished</h3>
          <ol className="mt-1 space-y-0.5">
            {finished.map((o) => (
              <li
                key={`${o.order_id}-${o.status}`}
                className="flex justify-between gap-2 text-[11px]"
                data-testid="finished-order"
                data-order-id={o.order_id}
                data-status={o.status}
              >
                <span className="metric text-fog-200">{o.order_id}</span>
                <span className={o.status === "shipped" ? "text-ok-400" : "text-fog-400"}>
                  {o.status} · tick {o.tick.toLocaleString("en-US")}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      <CommandFeedback types={["order.cancel"]} limit={2} />
    </div>
  );
}

// Trucks and docks -----------------------------------------------------------------------------

function TrucksAndDocks({ config, ops }: { config: SimulationConfig; ops: OperationsState }) {
  const tick = useSimulation((s) => s.tick);
  const docks = Object.keys(ops.docks).sort();
  const trucks = Object.values(ops.trucks).sort((a, b) => a.id.localeCompare(b.id));
  const aboard = (id: string) =>
    Object.values(ops.pallets).filter((p) => p.at.kind === "truck" && p.at.truck_id === id).length;
  return (
    <div>
      <h3 className="panel-title">Docks</h3>
      <ol className="mt-1 grid grid-cols-2 gap-1">
        {docks.map((id) => {
          const truck = ops.docks[id]?.truck_id;
          return (
            <li
              key={id}
              className="flex items-center justify-between gap-1 rounded-md bg-ink-800/70 px-2 py-1 text-[11px]"
              data-testid="dock-row"
              data-dock-id={id}
              data-status={truck ? "occupied" : "free"}
            >
              <Link selection={{ kind: "dock", id }}>{id}</Link>
              <span className={truck ? "text-warn-400" : "text-ok-400"}>{truck ?? "free"}</span>
            </li>
          );
        })}
      </ol>
      <h3 className="panel-title mt-3">Trucks on site</h3>
      {trucks.length === 0 ? (
        <Empty>No trucks on site.</Empty>
      ) : (
        <ol className="mt-1 space-y-1">
          {trucks.map((t) => (
            <li
              key={t.id}
              className="rounded-md bg-ink-800/70 px-2 py-1.5 text-[11px] leading-4"
              data-testid="truck-row"
              data-truck-id={t.id}
              data-status={t.status}
            >
              <div className="flex items-baseline justify-between gap-2">
                <Link selection={{ kind: "truck", id: t.id }}>{t.id}</Link>
                <span className="text-fog-400">
                  {t.direction} · <span className="text-data-300">{t.status}</span> ·{" "}
                  {formatTicks(config, tick - t.status_since_tick)}
                </span>
              </div>
              <p className="mt-0.5 text-fog-500">
                {t.dock_id ?? `yard slot ${t.yard_slot}`} · {aboard(t.id)} pallets aboard
                {t.order_id ? ` · ${t.order_id}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// New work -------------------------------------------------------------------------------------

function LinesEditor({
  config,
  lines,
  onChange,
  hint,
  testid,
}: {
  config: SimulationConfig;
  lines: CargoLine[];
  onChange: (lines: CargoLine[]) => void;
  hint?: (sku: string) => string;
  testid: string;
}) {
  const unused = config.skus.find((s) => !lines.some((l) => l.sku === s.id));
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => (
        <div key={i} className="grid grid-cols-[1fr_4rem_1.5rem] items-center gap-1.5">
          <select
            className={input}
            value={line.sku}
            aria-label={`SKU, line ${i + 1}`}
            data-testid={`${testid}-sku-${i}`}
            onChange={(e) =>
              onChange(lines.map((l, j) => (j === i ? { ...l, sku: e.target.value } : l)))
            }
          >
            {config.skus.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {hint ? ` (${hint(s.id)})` : ""}
              </option>
            ))}
          </select>
          <input
            className={input}
            type="number"
            min={1}
            max={26}
            value={line.quantity}
            aria-label={`Pallets, line ${i + 1}`}
            data-testid={`${testid}-qty-${i}`}
            onChange={(e) =>
              onChange(
                lines.map((l, j) => (j === i ? { ...l, quantity: Number(e.target.value) } : l)),
              )
            }
          />
          <button
            type="button"
            aria-label={`Remove line ${i + 1}`}
            disabled={lines.length === 1}
            className="text-fog-400 hover:text-fog-200 disabled:opacity-30"
            onClick={() => onChange(lines.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      {unused && lines.length < 4 && (
        <button
          type="button"
          className="text-[11px] text-fog-400 underline-offset-2 hover:text-fog-200 hover:underline"
          onClick={() => onChange([...lines, { sku: unused.id, quantity: 1 }])}
        >
          + Add line
        </button>
      )}
    </div>
  );
}

function NewWork({ config, ops }: { config: SimulationConfig; ops: OperationsState }) {
  const submit = useSimulation((s) => s.submitCommand);
  const first = config.skus[0]?.id ?? "";
  const [order, setOrder] = useState<CargoLine[]>([{ sku: first, quantity: 1 }]);
  const [inbound, setInbound] = useState<CargoLine[]>([{ sku: first, quantity: 2 }]);
  const free = useMemo(() => freeStock(ops), [ops]);
  return (
    <div className="space-y-4">
      {/* Results first, so a rejection and its explanation are visible right after submitting. */}
      <CommandFeedback types={["order.create", "truck.schedule_inbound"]} limit={3} />
      <form
        data-testid="order-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit({ type: "order.create", payload: { lines: order } });
        }}
      >
        <h3 className="panel-title">Outbound order</h3>
        <p className="mb-1.5 text-[11px] text-fog-500">
          Allocates free stock now; a truck is called, pallets are picked to the dock lane, loaded
          and shipped.
        </p>
        <LinesEditor
          config={config}
          lines={order}
          onChange={setOrder}
          hint={(sku) => `${free[sku] ?? 0} free`}
          testid="order"
        />
        <button type="submit" className={`${button} mt-2`} data-testid="order-submit">
          Create order
        </button>
      </form>
      <form
        data-testid="inbound-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit({ type: "truck.schedule_inbound", payload: { cargo: inbound } });
        }}
      >
        <h3 className="panel-title">Inbound truck</h3>
        <p className="mb-1.5 text-[11px] text-fog-500">
          The truck docks, pallets are unloaded to the lane and put away to the nearest free slots.
        </p>
        <LinesEditor config={config} lines={inbound} onChange={setInbound} testid="inbound" />
        <button type="submit" className={`${button} mt-2`} data-testid="inbound-submit">
          Schedule truck
        </button>
      </form>
    </div>
  );
}

export function OperationsPanel() {
  const config = useSimulation((s) => s.config);
  const ops = useSimulation((s) => s.state.ops);
  const [tab, setTab] = useState<Tab>("tasks");
  if (!ops) return null;
  const summary = opsSummary(ops);
  const counts: Record<Tab, number | null> = {
    tasks: summary.tasks,
    orders: summary.orders,
    trucks: summary.trucks,
    new: null,
  };
  return (
    <section
      className="panel pointer-events-auto mr-auto hidden max-h-full w-80 min-h-0 flex-col p-3 md:flex"
      aria-labelledby="ops-title"
      data-testid="operations-panel"
    >
      <h2 id="ops-title" className="panel-title">
        Operations
      </h2>
      <div role="tablist" aria-label="Operations views" className="mt-2 flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`ops-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-2 py-1 text-[11px] transition ${
              tab === t.id ? "bg-ink-700 text-fog-50" : "text-fog-400 hover:text-fog-200"
            }`}
          >
            {t.label}
            {counts[t.id] !== null && (
              <span className="metric ml-1 text-fog-500">{counts[t.id]}</span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-2 min-h-0 overflow-y-auto pr-1">
        {tab === "tasks" && <TaskQueue config={config} ops={ops} />}
        {tab === "orders" && <Orders ops={ops} />}
        {tab === "trucks" && <TrucksAndDocks config={config} ops={ops} />}
        {tab === "new" && <NewWork config={config} ops={ops} />}
      </div>
    </section>
  );
}
