"use client";

import type { EquipmentConfig } from "@warehouse-one/simulation";
import { useMemo } from "react";
import { useSimulation } from "@/lib/sim/store";
import { useView } from "@/lib/world/view-store";
import { archetypeForSku, levelsFor, resolveFacility } from "@/world/derive";
import { CARGO_COLOR } from "@/world/materials";

const KIND_LABEL: Record<EquipmentConfig["kind"], string> = {
  counterbalance_forklift: "Counterbalance forklift",
  reach_truck: "Reach truck",
  truck: "Semi-trailer truck",
};

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
        className="mt-1 w-full rounded-md bg-ink-800 px-2 py-1.5 text-xs text-fog-50"
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

function Shell({
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
      className="panel pointer-events-auto w-72 max-w-[calc(100vw-1.5rem)] p-4"
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

export function InspectorPanel() {
  const config = useSimulation((s) => s.config);
  const inventory = useSimulation((s) => s.inventory);
  const selection = useSimulation((s) => s.selection);
  const facility = useMemo(() => resolveFacility(config), [config]);

  if (!selection) {
    return (
      <aside
        className="panel pointer-events-auto hidden w-64 p-4 md:block"
        data-testid="inspector-empty"
      >
        <h2 className="panel-title">Inspector</h2>
        <p className="mt-2 text-xs leading-5 text-fog-400">
          Click a rack bay, vehicle or dock to inspect it. Double-click to fly to it. Drag to orbit,
          right-drag to pan, scroll to zoom.
        </p>
        <LocationPicker />
      </aside>
    );
  }

  if (selection.kind === "location") {
    const location = config.locations.find((l) => l.id === selection.id);
    if (!location) return null;
    const row = inventory[location.id] ?? {};
    const rows = Object.entries(row);
    const used = rows.reduce((n, [, q]) => n + q, 0);
    const levels = levelsFor(location.capacity, facility.rack);
    const skuName = (id: string) => config.skus.find((s) => s.id === id)?.name ?? id;
    return (
      <Shell title={location.id} subtitle="Rack bay">
        <p className="text-[11px] text-fog-400">
          {location.zone} · {levels} levels × {facility.rack.positions_per_level} positions
        </p>
        <div className="mt-3">
          <div className="flex justify-between text-[11px] text-fog-400">
            <span>Occupancy</span>
            <span className="metric text-fog-200" data-testid="inspector-occupancy">
              {used} / {location.capacity} positions
            </span>
          </div>
          <div
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-700"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={location.capacity}
            aria-valuenow={used}
            aria-label="Occupancy"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-data-400 to-signal-400"
              style={{ width: `${(used / location.capacity) * 100}%` }}
            />
          </div>
        </div>
        <ul className="mt-3 space-y-1.5">
          {rows.length === 0 ? (
            <li className="text-xs text-fog-500">Empty bay</li>
          ) : (
            rows.map(([sku, q]) => (
              <li key={sku} className="flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-sm"
                    style={{ background: CARGO_COLOR[archetypeForSku(config, sku)] }}
                    aria-hidden="true"
                  />
                  <span className="truncate text-fog-200" title={sku}>
                    {skuName(sku)}
                  </span>
                </span>
                <span className="metric text-fog-50">{q}</span>
              </li>
            ))
          )}
        </ul>
        <p className="mt-3 text-[11px] leading-4 text-fog-500">
          Quantities are live simulation state. Beam-level placement is a display convention
          (bottom-up) until per-pallet tracking arrives in Phase 2.
        </p>
      </Shell>
    );
  }

  if (selection.kind === "equipment") {
    const e = facility.equipment.find((v) => v.id === selection.id);
    if (!e) return null;
    const dock = e.dock_id ? facility.docks.find((d) => d.id === e.dock_id) : undefined;
    return (
      <Shell title={e.id} subtitle={KIND_LABEL[e.kind]}>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-fog-400">Model</dt>
          <dd className="text-fog-200">{e.label}</dd>
          <dt className="text-fog-400">Rated load</dt>
          <dd className="metric text-fog-200">{e.rated_capacity_kg.toLocaleString("en-US")} kg</dd>
          <dt className="text-fog-400">Position</dt>
          <dd className="metric text-fog-200">
            {e.position.x.toFixed(1)}, {e.position.z.toFixed(1)} m
          </dd>
          {dock && (
            <>
              <dt className="text-fog-400">At dock</dt>
              <dd className="metric text-fog-200">{dock.id}</dd>
            </>
          )}
          <dt className="text-fog-400">Status</dt>
          <dd className="text-fog-200" data-testid="inspector-status">
            Parked
          </dd>
        </dl>
        <p className="mt-3 text-[11px] leading-4 text-fog-500">
          From facility master data. Vehicles are static until tasks, routing and utilisation are
          simulated in Phase 2.
        </p>
      </Shell>
    );
  }

  const dock = facility.docks.find((d) => d.id === selection.id);
  if (!dock) return null;
  const truck = facility.equipment.find((e) => e.dock_id === dock.id);
  return (
    <Shell title={dock.id} subtitle="Loading dock">
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-fog-400">Vehicle</dt>
        <dd className="metric text-fog-200">{truck ? truck.id : "None assigned"}</dd>
        <dt className="text-fog-400">Door</dt>
        <dd className="text-fog-200">3.0 × 3.2 m, leveller + shelter</dd>
      </dl>
      <p className="mt-3 text-[11px] leading-4 text-fog-500">
        Door cycles, arrivals and departures are simulated from Phase 2.
      </p>
    </Shell>
  );
}
