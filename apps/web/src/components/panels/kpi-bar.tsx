"use client";

import { useMemo } from "react";
import { stockSummary, useSimulation } from "@/lib/sim/store";
import { resolveFacility } from "@/world/derive";

/** Facility KPIs computed live from authoritative state and config (nothing estimated). */
export function KpiBar() {
  const config = useSimulation((s) => s.config);
  const inventory = useSimulation((s) => s.inventory);
  const s = useMemo(() => stockSummary(config, inventory), [config, inventory]);
  const fleet = resolveFacility(config).equipment;
  const vehicles = fleet.filter((e) => e.kind !== "truck").length;
  const trucks = fleet.length - vehicles;

  const chips = [
    {
      label: "Stock on hand",
      value: s.units.toLocaleString("en-US"),
      unit: "pallets",
      testid: "kpi-stock",
    },
    {
      label: "Utilisation",
      value: `${Math.round(s.utilisation * 100)}%`,
      unit: `of ${s.capacity.toLocaleString("en-US")}`,
      testid: "kpi-utilisation",
    },
    { label: "Bays in use", value: `${s.occupied}`, unit: `/ ${s.locations}`, testid: "kpi-bays" },
    {
      label: "Fleet",
      value: `${vehicles}`,
      unit: trucks ? `MHE · ${trucks} trucks` : "MHE",
      testid: "kpi-fleet",
    },
  ];
  return (
    <ul
      aria-label="Facility indicators"
      className="pointer-events-auto flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]"
    >
      {chips.map((c, i) => (
        <li
          key={c.label}
          className={`panel min-w-fit px-3 py-2 ${i >= 2 ? "hidden sm:block" : ""}`}
          data-testid={c.testid}
        >
          <p className="text-[11px] font-medium tracking-wide text-fog-400 uppercase">{c.label}</p>
          <p className="mt-0.5 flex items-baseline gap-1.5">
            <span className="metric text-base text-fog-50">{c.value}</span>
            <span className="text-[11px] text-fog-400">{c.unit}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}
