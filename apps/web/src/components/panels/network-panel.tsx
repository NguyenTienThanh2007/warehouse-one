"use client";

import { cargoTotal, type LinehaulState } from "@warehouse-one/simulation";
import { useSimulation } from "@/lib/sim/store";
import { networkSummary } from "@/world/network-view";
import { formatTicks } from "./format";
import { LINEHAUL_STATUS_LABEL } from "./network-inspectors";

const STATUS_TONE: Partial<Record<LinehaulState["status"], string>> = {
  driving: "text-data-300",
  loading: "text-signal-300",
  unloading: "text-signal-300",
  at_dc: "text-signal-300",
  waiting: "text-critical-400",
  servicing: "text-fog-400",
};

/**
 * The whole-network view: every transfer in progress and every line-haul truck, read from
 * `state.network`. Shown instead of the DC's operations panel when the camera is not on the DC.
 */
export function NetworkPanel() {
  const config = useSimulation((s) => s.config);
  const state = useSimulation((s) => s.state);
  const tick = useSimulation((s) => s.tick);
  const select = useSimulation((s) => s.select);
  const net = state.network;
  if (!net || !config.network) return null;
  const summary = networkSummary(state);
  const name = (id: string) => config.network?.sites.find((s) => s.id === id)?.name ?? id;
  const transfers = Object.values(net.transfers).sort((a, b) => a.id.localeCompare(b.id));
  const vehicles = Object.values(net.vehicles).sort((a, b) => a.id.localeCompare(b.id));
  return (
    <section
      className="panel pointer-events-auto mr-auto hidden max-h-full w-80 min-h-0 flex-col p-3 md:flex"
      aria-labelledby="net-title"
      data-testid="network-panel"
    >
      <h2 id="net-title" className="panel-title">
        Logistics network
      </h2>
      <p className="mt-1 text-[11px] text-fog-400">
        {summary?.moving ?? 0} of {summary?.trucks ?? 0} trucks on the move ·{" "}
        {summary?.activeTransfers ?? 0} transfers · {summary?.inTransitPallets ?? 0} pallets aboard
      </p>
      <div className="mt-2 min-h-0 overflow-y-auto">
        <p className="panel-title text-[10px]">Transfers</p>
        {transfers.length === 0 ? (
          <p className="py-1 text-xs text-fog-500">No transfers in progress.</p>
        ) : (
          <ul className="mt-1 space-y-1" data-testid="network-transfers">
            {transfers.slice(0, 6).map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={!t.vehicle_id}
                  onClick={() => t.vehicle_id && select({ kind: "linehaul", id: t.vehicle_id })}
                  className="w-full rounded-md bg-ink-800/70 px-2 py-1 text-left text-[11px] transition enabled:hover:bg-ink-700"
                  data-testid="network-transfer"
                  data-status={t.status}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="metric text-fog-200">{t.id}</span>
                    <span className="text-fog-400">
                      {t.status.replace("_", " ")} · {cargoTotal(t.lines)} plt
                    </span>
                  </span>
                  <span className="block truncate text-fog-400">
                    {name(t.from_site)} → {name(t.to_site)}
                    {t.vehicle_id ? ` · ${t.vehicle_id}` : " · awaiting a truck"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="panel-title mt-3 text-[10px]">Fleet</p>
        <ul className="mt-1 space-y-0.5" data-testid="network-fleet">
          {vehicles.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => select({ kind: "linehaul", id: v.id })}
                className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-white/5"
                data-testid={`fleet-row-${v.id}`}
              >
                <span className="metric text-fog-200">{v.id}</span>
                <span className={`truncate ${STATUS_TONE[v.status] ?? "text-fog-400"}`}>
                  {LINEHAUL_STATUS_LABEL[v.status]}
                  {v.site_id ? ` · ${name(v.site_id)}` : ""}
                </span>
                <span className="metric shrink-0 text-fog-500">
                  {formatTicks(config, tick - v.status_since_tick)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
