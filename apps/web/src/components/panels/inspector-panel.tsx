"use client";

import {
  equipmentPose,
  navGraph,
  STAGING_LANE_CAPACITY,
  type EquipmentConfig,
  type EquipmentState,
  type OperationsState,
  type SimulationConfig,
} from "@warehouse-one/simulation";
import { useMemo, useState } from "react";
import { useSimulation } from "@/lib/sim/store";
import { useView } from "@/lib/world/view-store";
import { archetypeForSku, levelsFor, resolveFacility } from "@/world/derive";
import { CARGO_COLOR } from "@/world/materials";
import { CommandFeedback } from "./command-feedback";
import { LinehaulInspector, SiteInspector } from "./network-inspectors";
import { formatTicks } from "./format";

const KIND_LABEL: Record<EquipmentConfig["kind"], string> = {
  counterbalance_forklift: "Counterbalance forklift",
  reach_truck: "Reach truck",
  truck: "Semi-trailer truck",
};

export const EQUIPMENT_STATUS_LABEL: Record<EquipmentState["status"], string> = {
  idle: "Idle",
  travelling: "Travelling",
  handling: "Handling a pallet",
  charging: "Charging",
};

const PURPOSE_LABEL = { task: "to a task", park: "home to park", charge: "to charge" } as const;

export const input = "mt-1 w-full rounded-md bg-ink-800 px-2 py-1.5 text-xs text-fog-50";
export const button =
  "rounded-md bg-signal-400 px-2.5 py-1 text-[11px] font-semibold text-ink-950 transition hover:bg-signal-300 disabled:opacity-40";

function LocationPicker() {
  const config = useSimulation((s) => s.config);
  const select = useSimulation((s) => s.select);
  const requestCamera = useView((s) => s.requestCamera);
  return (
    <label className="mt-3 block text-[11px] text-fog-400">
      Jump to location
      <select
        data-testid="location-picker"
        defaultValue=""
        onChange={(e) => {
          if (!e.target.value) return;
          select({ kind: "location", id: e.target.value });
          requestCamera("focus");
        }}
        className={input}
      >
        <option value="">Choose a bay…</option>
        {config.locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.id}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Shell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const select = useSimulation((s) => s.select);
  const requestCamera = useView((s) => s.requestCamera);
  return (
    <aside
      className="panel pointer-events-auto max-h-full w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto p-4"
      aria-labelledby="inspector-title"
      data-testid="inspector"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="panel-title">{subtitle}</h2>
          <p id="inspector-title" className="metric mt-1 truncate text-lg">
            {title}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => requestCamera("focus")}
            aria-label="Focus camera (F)"
            title="Focus camera (F)"
            className="rounded-md px-1.5 py-0.5 text-[11px] text-fog-400 hover:bg-white/5 hover:text-fog-200"
          >
            Focus
          </button>
          <button
            type="button"
            onClick={() => select(null)}
            aria-label="Close inspector (Esc)"
            className="rounded-md px-1.5 text-fog-400 hover:bg-white/5"
          >
            ×
          </button>
        </div>
      </div>
      {children}
    </aside>
  );
}

export function Rows({ children }: { children: React.ReactNode }) {
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs [&>dd]:min-w-0 [&>dd]:truncate [&>dd]:text-fog-200 [&>dt]:text-fog-400">
      {children}
    </dl>
  );
}

export function OccupancyBar({ used, capacity }: { used: number; capacity: number }) {
  return (
    <div
      className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-700"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={capacity}
      aria-valuenow={used}
      aria-label="Occupancy"
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-data-400 to-signal-400"
        style={{ width: `${(used / Math.max(1, capacity)) * 100}%` }}
      />
    </div>
  );
}

export function SkuSwatch({ config, sku }: { config: SimulationConfig; sku: string }) {
  return (
    <span
      className="size-2.5 shrink-0 rounded-sm"
      style={{ background: CARGO_COLOR[archetypeForSku(config, sku)] }}
      aria-hidden="true"
    />
  );
}

// Rack bay -------------------------------------------------------------------------------------

/** Operator actions on a bay: relocate one of its free pallets, or receive stock into it. */
function BayActions({
  config,
  ops,
  locationId,
}: {
  config: SimulationConfig;
  ops: OperationsState;
  locationId: string;
}) {
  const submit = useSimulation((s) => s.submitCommand);
  const movable = Object.values(ops.pallets)
    .filter(
      (p) => p.at.kind === "slot" && p.at.location_id === locationId && !p.order_id && !p.task_id,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const [pallet, setPallet] = useState("");
  const [target, setTarget] = useState("");
  const [sku, setSku] = useState(config.skus[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const chosen = movable.some((p) => p.id === pallet) ? pallet : (movable[0]?.id ?? "");

  return (
    <div className="mt-3 space-y-3 border-t border-white/5 pt-3">
      <form
        className="text-[11px] text-fog-400"
        data-testid="relocate-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen || !target) return;
          submit({
            type: "pallet.relocate",
            payload: { pallet_id: chosen, to_location_id: target },
          });
        }}
      >
        <p className="panel-title">Relocate a pallet</p>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <label>
            Pallet
            <select
              className={input}
              value={chosen}
              onChange={(e) => setPallet(e.target.value)}
              data-testid="relocate-pallet"
              disabled={movable.length === 0}
            >
              {movable.length === 0 && <option value="">None free</option>}
              {movable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            To bay
            <select
              className={input}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              data-testid="relocate-target"
            >
              <option value="">Choose…</option>
              {config.locations
                .filter((l) => l.id !== locationId)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.id}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <button type="submit" className={`${button} mt-2`} disabled={!chosen || !target}>
          Create relocation task
        </button>
      </form>
      <form
        className="text-[11px] text-fog-400"
        data-testid="receive-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit({
            type: "inventory.receive",
            payload: { location_id: locationId, sku, quantity },
          });
        }}
      >
        <p className="panel-title">Receive stock directly</p>
        <div className="mt-1 grid grid-cols-[1fr_4rem] gap-2">
          <label>
            SKU
            <select className={input} value={sku} onChange={(e) => setSku(e.target.value)}>
              {config.skus.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pallets
            <input
              className={input}
              type="number"
              min={1}
              max={99}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </label>
        </div>
        <button type="submit" className={`${button} mt-2`}>
          Receive into bay
        </button>
      </form>
      <CommandFeedback types={["pallet.relocate", "inventory.receive"]} limit={3} />
    </div>
  );
}

function LocationInspector({ id }: { id: string }) {
  const config = useSimulation((s) => s.config);
  const inventory = useSimulation((s) => s.inventory);
  const ops = useSimulation((s) => s.state.ops);
  const facility = useMemo(() => resolveFacility(config), [config]);
  const location = config.locations.find((l) => l.id === id);
  if (!location) return null;
  const levels = levelsFor(location.capacity, facility.rack);
  const skuName = (sku: string) => config.skus.find((s) => s.id === sku)?.name ?? sku;

  if (!ops) {
    // Phase 0 configs: per-bay quantities only.
    const rows = Object.entries(inventory[location.id] ?? {});
    const used = rows.reduce((n, [, q]) => n + q, 0);
    return (
      <Shell title={location.id} subtitle="Rack bay">
        <p className="text-[11px] text-fog-400">
          {location.zone} · {levels} levels × {facility.rack.positions_per_level} positions
        </p>
        <div className="mt-3 flex justify-between text-[11px] text-fog-400">
          <span>Occupancy</span>
          <span className="metric text-fog-200" data-testid="inspector-occupancy">
            {used} / {location.capacity} positions
          </span>
        </div>
        <OccupancyBar used={used} capacity={location.capacity} />
        <p className="mt-3 text-[11px] leading-4 text-fog-500">
          This scenario tracks quantities per bay only; beam placement is a display convention.
        </p>
      </Shell>
    );
  }

  const slots = Array.from({ length: location.capacity }, (_, slot) => {
    const pallet = Object.values(ops.pallets).find(
      (p) => p.at.kind === "slot" && p.at.location_id === id && p.at.slot === slot,
    );
    const incoming = ops.reservations[`slot:${id}:${slot}`];
    return { slot, pallet, incoming };
  });
  const used = slots.filter((s) => s.pallet).length;
  const reserved = slots.filter((s) => !s.pallet && s.incoming).length;

  return (
    <Shell title={location.id} subtitle="Rack bay">
      <p className="text-[11px] text-fog-400">
        {location.zone} · {levels} levels × {facility.rack.positions_per_level} positions
      </p>
      <div className="mt-3 flex justify-between text-[11px] text-fog-400">
        <span>Occupancy</span>
        <span className="metric text-fog-200" data-testid="inspector-occupancy">
          {used} / {location.capacity} positions
        </span>
      </div>
      <OccupancyBar used={used} capacity={location.capacity} />
      {reserved > 0 && (
        <p className="mt-1 text-[11px] text-fog-400">{reserved} reserved for incoming pallets</p>
      )}
      <ol className="mt-3 space-y-1" data-testid="bay-slots">
        {slots
          .filter((s) => s.pallet || s.incoming)
          .map(({ slot, pallet, incoming }) => (
            <li key={slot} className="flex items-center justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-2">
                <span className="metric w-10 shrink-0 text-fog-500">#{slot}</span>
                {pallet ? (
                  <>
                    <SkuSwatch config={config} sku={pallet.sku} />
                    <span className="truncate text-fog-200" title={pallet.sku}>
                      {skuName(pallet.sku)}
                    </span>
                  </>
                ) : (
                  <span className="text-fog-400">incoming · {incoming}</span>
                )}
              </span>
              {pallet && (
                <span className="metric shrink-0 text-[11px] text-fog-400">
                  {pallet.task_id ?? pallet.order_id ?? pallet.id}
                </span>
              )}
            </li>
          ))}
        {used === 0 && reserved === 0 && <li className="text-xs text-fog-500">Empty bay</li>}
      </ol>
      <BayActions key={id} config={config} ops={ops} locationId={id} />
    </Shell>
  );
}

// Vehicle --------------------------------------------------------------------------------------

function EquipmentInspector({ id }: { id: string }) {
  const config = useSimulation((s) => s.config);
  const ops = useSimulation((s) => s.state.ops);
  const facility = useMemo(() => resolveFacility(config), [config]);
  const spec = facility.equipment.find((v) => v.id === id);
  const e = ops?.equipment[id];
  if (!spec || !e || !ops) return null;
  const pose = equipmentPose(navGraph(config), e);
  const task = e.task_id ? ops.tasks[e.task_id] : undefined;
  const carried = e.carrying ? ops.pallets[e.carrying] : undefined;
  return (
    <Shell title={e.id} subtitle={KIND_LABEL[spec.kind]}>
      <Rows>
        <dt>Status</dt>
        <dd data-testid="inspector-status">{EQUIPMENT_STATUS_LABEL[e.status]}</dd>
        {e.status === "travelling" && e.purpose && (
          <>
            <dt>Heading</dt>
            <dd>{PURPOSE_LABEL[e.purpose]}</dd>
          </>
        )}
        {e.blocked_by && (
          <>
            <dt>Waiting</dt>
            <dd>
              for {e.blocked_by} · {e.wait_ticks} ticks
            </dd>
          </>
        )}
        <dt>Task</dt>
        <dd className="metric" data-testid="inspector-task">
          {task ? `${task.id} · ${task.type} · ${task.status}` : "None"}
        </dd>
        <dt>Carrying</dt>
        <dd className="metric">{carried ? `${carried.id} (${carried.sku})` : "Nothing"}</dd>
        <dt>Battery</dt>
        <dd className="metric" data-testid="inspector-battery">
          {(e.battery_permille / 10).toFixed(1)}%
        </dd>
        <dt>Position</dt>
        <dd className="metric">
          {pose.x.toFixed(1)}, {pose.z.toFixed(1)} m
        </dd>
        <dt>Odometer</dt>
        <dd className="metric">{(e.odometer_mm / 1_000_000).toFixed(2)} km</dd>
        <dt>Model</dt>
        <dd>{spec.label}</dd>
        <dt>Rated load</dt>
        <dd className="metric">{spec.rated_capacity_kg.toLocaleString("en-US")} kg</dd>
      </Rows>
      <p className="mt-3 text-[11px] leading-4 text-fog-500">
        Live simulation state, updated every tick.
      </p>
    </Shell>
  );
}

// Dock -----------------------------------------------------------------------------------------

function DockInspector({ id }: { id: string }) {
  const config = useSimulation((s) => s.config);
  const ops = useSimulation((s) => s.state.ops);
  const select = useSimulation((s) => s.select);
  const dock = config.facility?.docks.find((d) => d.id === id);
  if (!dock) return null;
  const truckId = ops?.docks[id]?.truck_id ?? null;
  const truck = truckId ? ops?.trucks[truckId] : undefined;
  const staged = ops
    ? Object.values(ops.pallets).filter((p) => p.at.kind === "staging" && p.at.dock_id === id)
        .length
    : 0;
  return (
    <Shell title={dock.id} subtitle="Loading dock">
      <Rows>
        <dt>Status</dt>
        <dd data-testid="inspector-status">{truck ? "Occupied" : "Free"}</dd>
        <dt>Truck</dt>
        <dd className="metric">
          {truck ? (
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => select({ kind: "truck", id: truck.id })}
            >
              {truck.id} · {truck.direction} · {truck.status}
            </button>
          ) : (
            "None"
          )}
        </dd>
        <dt>Staging lane</dt>
        <dd className="metric">
          {staged} / {STAGING_LANE_CAPACITY} pallets
        </dd>
        <dt>Door</dt>
        <dd>3.0 × 3.2 m, leveller + shelter</dd>
      </Rows>
    </Shell>
  );
}

// Truck ----------------------------------------------------------------------------------------

function TruckInspector({ id }: { id: string }) {
  const config = useSimulation((s) => s.config);
  const ops = useSimulation((s) => s.state.ops);
  const tick = useSimulation((s) => s.tick);
  const t = ops?.trucks[id];
  if (!ops || !t) {
    return (
      <Shell title={id} subtitle="Truck">
        <p className="mt-1 text-xs text-fog-400" data-testid="inspector-status">
          Left the site
        </p>
      </Shell>
    );
  }
  const aboard = Object.values(ops.pallets).filter(
    (p) => p.at.kind === "truck" && p.at.truck_id === id,
  ).length;
  const order = t.order_id ? ops.orders[t.order_id] : undefined;
  return (
    <Shell title={t.id} subtitle={t.direction === "inbound" ? "Inbound truck" : "Outbound truck"}>
      <Rows>
        <dt>Status</dt>
        <dd data-testid="inspector-status">{t.status}</dd>
        <dt>For</dt>
        <dd className="metric">{formatTicks(config, tick - t.status_since_tick)}</dd>
        <dt>Dock</dt>
        <dd className="metric">{t.dock_id ?? `yard slot ${t.yard_slot}`}</dd>
        <dt>Pallets aboard</dt>
        <dd className="metric">{aboard}</dd>
        {order && (
          <>
            <dt>Order</dt>
            <dd className="metric">
              {order.id} · {order.status}
            </dd>
          </>
        )}
      </Rows>
    </Shell>
  );
}

export function InspectorPanel() {
  const selection = useSimulation((s) => s.selection);

  if (!selection) {
    return (
      <aside
        className="panel pointer-events-auto hidden w-64 p-4 md:block"
        data-testid="inspector-empty"
      >
        <h2 className="panel-title">Inspector</h2>
        <p className="mt-2 text-xs leading-5 text-fog-400">
          Click a site, rack bay, vehicle, truck or dock to inspect it. Double-click to fly to it.
          Drag to orbit, right-drag to pan, scroll to zoom.
        </p>
        <LocationPicker />
      </aside>
    );
  }
  switch (selection.kind) {
    case "location":
      return <LocationInspector id={selection.id} />;
    case "equipment":
      return <EquipmentInspector id={selection.id} />;
    case "dock":
      return <DockInspector id={selection.id} />;
    case "truck":
      return <TruckInspector id={selection.id} />;
    case "site":
      return <SiteInspector id={selection.id} />;
    case "linehaul":
      return <LinehaulInspector id={selection.id} />;
  }
}
