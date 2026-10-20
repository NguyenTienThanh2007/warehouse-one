"use client";

import { useSimulation } from "@/lib/sim/store";

export function InspectorPanel() {
  const config = useSimulation((s) => s.config);
  const inventory = useSimulation((s) => s.inventory);
  const selectedId = useSimulation((s) => s.selectedLocationId);
  const select = useSimulation((s) => s.select);
  const location = selectedId ? config.locations.find((l) => l.id === selectedId) : undefined;

  if (!location) {
    return (
      <aside
        className="panel pointer-events-auto hidden w-64 p-4 md:block"
        data-testid="inspector-empty"
      >
        <h2 className="panel-title">Inspector</h2>
        <p className="mt-2 text-xs leading-5 text-fog-400">
          Select a storage location in the scene to inspect its live contents. Drag to orbit, scroll
          to zoom, right-drag to pan.
        </p>
        <p className="mt-3 border-t border-white/5 pt-2.5 text-[10px] leading-4 text-fog-500">
          Phase 0 diagnostic scene: schematic geometry driven by live simulation state. The final 3D
          world arrives in Phase 1.
        </p>
      </aside>
    );
  }

  const rows = Object.entries(inventory[location.id] ?? {});
  const used = rows.reduce((n, [, q]) => n + q, 0);
  const skuName = (id: string) => config.skus.find((s) => s.id === id)?.name ?? id;

  return (
    <aside
      className="panel pointer-events-auto w-72 p-4"
      aria-labelledby="inspector-title"
      data-testid="inspector"
    >
      <div className="flex items-start justify-between">
        <div>
          <h2 className="panel-title">Storage location</h2>
          <p id="inspector-title" className="metric mt-1 text-lg">
            {location.id}
          </p>
          <p className="text-[11px] text-fog-400">{location.zone}</p>
        </div>
        <button
          type="button"
          onClick={() => select(null)}
          aria-label="Close inspector (Esc)"
          className="rounded-md px-1.5 text-fog-400 hover:bg-white/5"
        >
          ×
        </button>
      </div>

      <div className="mt-3">
        <div className="flex justify-between text-[11px] text-fog-400">
          <span>Occupancy</span>
          <span className="metric text-fog-200">
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
          <li className="text-xs text-fog-500">Empty</li>
        ) : (
          rows.map(([sku, q]) => (
            <li key={sku} className="flex justify-between gap-3 text-xs">
              <span className="truncate text-fog-200" title={sku}>
                {skuName(sku)}
              </span>
              <span className="metric text-fog-50">{q}</span>
            </li>
          ))
        )}
      </ul>
      <p className="mt-3 text-[10px] text-fog-500">Live from authoritative simulation state.</p>
    </aside>
  );
}
