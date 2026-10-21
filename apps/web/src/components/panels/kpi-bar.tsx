"use client";

import { useMemo } from "react";
import { stockSummary, useSimulation } from "@/lib/sim/store";
import { resolveFacility } from "@/world/derive";
import { networkSummary } from "@/world/network-view";
import { opsSummary } from "@/world/ops-view";

/** Facility KPIs computed live from authoritative state and config (nothing estimated). */
export function KpiBar() {
  const config = useSimulation((s) => s.config);
  const inventory = useSimulation((s) => s.inventory);
  const ops = useSimulation((s) => s.state.ops);
  const s = useMemo(() => stockSummary(config, inventory), [config, inventory]);
  const o = useMemo(() => (ops ? opsSummary(ops) : null), [ops]);
  const mhe = resolveFacility(config).equipment.filter((e) => e.kind !== "truck").length;
  const state = useSimulation((s) => s.state);
  const n = useMemo(() => networkSummary(state), [state]);

  const chips = [
    {
      label: "Stock in racks",
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
    o
      ? {
          label: "Fleet busy",
          value: `${o.vehiclesBusy}`,
          unit: `/ ${o.vehicles} MHE`,
          testid: "kpi-fleet",
        }
      : { label: "Fleet", value: `${mhe}`, unit: "MHE", testid: "kpi-fleet" },
    ...(o
      ? [
          {
            label: "Open tasks",
            value: `${o.tasks}`,
            unit: `${o.tasksByStatus.pending} waiting`,
            testid: "kpi-tasks",
          },
          {
            label: "Trucks on site",
            value: `${o.trucks}`,
            unit: `${o.docksOccupied} / ${o.docks} docks`,
            testid: "kpi-trucks",
          },
        ]
      : []),
    ...(n
      ? [
          {
            label: "Line-haul moving",
            value: `${n.moving}`,
            unit: `/ ${n.trucks} trucks`,
            testid: "kpi-linehaul",
          },
          {
            label: "Transfers",
            value: `${n.activeTransfers}`,
            unit: `${n.inTransitPallets} pallets aboard`,
            testid: "kpi-transfers",
          },
        ]
      : []),
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
