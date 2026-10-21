"use client";

import {
  cargoTotal,
  type LinehaulState,
  type SimulationConfig,
  type TransferState,
} from "@warehouse-one/simulation";
import { useState } from "react";
import { useSimulation, stockSummary } from "@/lib/sim/store";
import { useView } from "@/lib/world/view-store";
import { resolveSites, SITE_KIND_LABEL, siteActivity } from "@/world/network-view";
import { opsSummary } from "@/world/ops-view";
import { CommandFeedback } from "./command-feedback";
import { formatTicks } from "./format";
import { button, input, OccupancyBar, Rows, Shell, SkuSwatch } from "./inspector-panel";

export const LINEHAUL_STATUS_LABEL: Record<LinehaulState["status"], string> = {
  parked: "Parked",
  driving: "Driving",
  docking: "Reversing onto a stand",
  loading: "Loading",
  unloading: "Unloading",
  waiting: "Waiting",
  undocking: "Pulling out",
  at_dc: "At the distribution centre",
  off_network: "Last-mile run (off map)",
  servicing: "In service",
};

const siteName = (config: SimulationConfig, id: string) =>
  config.network?.sites.find((s) => s.id === id)?.name ?? id;

function TransferRow({
  t,
  config,
  here,
}: {
  t: TransferState;
  config: SimulationConfig;
  here: string;
}) {
  const select = useSimulation((s) => s.select);
  const other = t.from_site === here ? t.to_site : t.from_site;
  return (
    <li
      className="flex items-baseline justify-between gap-2 rounded-md bg-ink-800/70 px-2 py-1 text-[11px]"
      data-testid="transfer-row"
      data-transfer-id={t.id}
      data-status={t.status}
    >
      <span className="min-w-0 truncate text-fog-200">
        <span className="metric">{t.id}</span> {t.from_site === here ? "→" : "←"}{" "}
        {siteName(config, other)}
      </span>
      <span className="shrink-0 text-fog-400">
        {cargoTotal(t.lines)} plt ·{" "}
        {t.vehicle_id ? (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => select({ kind: "linehaul", id: t.vehicle_id as string })}
          >
            {t.status.replace("_", " ")}
          </button>
        ) : (
          t.status
        )}
      </span>
    </li>
  );
}

/** Ask the network to move pallets from this site to another (`transfer.request`). */
function RequestTransfer({ config, from }: { config: SimulationConfig; from: string }) {
  const submit = useSimulation((s) => s.submitCommand);
  const targets = (config.network?.sites ?? []).filter(
    (s) => s.id !== from && s.kind !== "fleet_depot",
  );
  const [to, setTo] = useState(targets[0]?.id ?? "");
  const [sku, setSku] = useState(config.skus[0]?.id ?? "");
  const [quantity, setQuantity] = useState(4);
  return (
    <form
      className="mt-3 border-t border-white/5 pt-3 text-[11px] text-fog-400"
      data-testid="transfer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!to || !sku) return;
        submit({
          type: "transfer.request",
          payload: { from_site_id: from, to_site_id: to, lines: [{ sku, quantity }] },
        });
      }}
    >
      <p className="panel-title">Request a transfer</p>
      <label className="mt-1 block">
        To
        <select
          className={input}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          data-testid="transfer-to"
        >
          {targets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-1 grid grid-cols-[1fr_4rem] gap-2">
        <label>
          SKU
          <select
            className={input}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            data-testid="transfer-sku"
          >
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
            max={26}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            data-testid="transfer-quantity"
          />
        </label>
      </div>
      <button type="submit" className={`${button} mt-2`} data-testid="transfer-submit">
        Plan transfer
      </button>
      <div className="mt-2">
        <CommandFeedback types={["transfer.request"]} limit={3} />
      </div>
    </form>
  );
}

export function SiteInspector({ id }: { id: string }) {
  const config = useSimulation((s) => s.config);
  const state = useSimulation((s) => s.state);
  const inventory = useSimulation((s) => s.inventory);
  const select = useSimulation((s) => s.select);
  const requestSite = useView((s) => s.requestSite);
  const site = resolveSites(config).find((s) => s.id === id);
  if (!site) return null;
  const a = siteActivity(config, state, id);
  const ships =
    site.kind === "distribution_center" ||
    site.kind === "cross_dock" ||
    site.kind === "container_terminal";
  const dc = site.primary ? stockSummary(config, inventory) : null;
  const ops = site.primary && state.ops ? opsSummary(state.ops) : null;
  const devanning = state.network?.sites[id]?.devan_ticks_left ?? 0;
  const active = a ? [...a.outbound, ...a.inbound].sort((x, y) => x.id.localeCompare(y.id)) : [];
  return (
    <Shell title={site.name} subtitle={SITE_KIND_LABEL[site.kind]}>
      <button
        type="button"
        className="mt-1 rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-fog-200 hover:bg-white/10"
        onClick={() => requestSite(id)}
        data-testid="site-fly-to"
      >
        Open facility view
      </button>
      <Rows>
        <dt>Site</dt>
        <dd className="metric" data-testid="inspector-site-id">
          {id}
        </dd>
        {dc && (
          <>
            <dt>Stock in racks</dt>
            <dd className="metric">
              {dc.units} / {dc.capacity} pallets
            </dd>
          </>
        )}
        {ops && (
          <>
            <dt>Docks</dt>
            <dd className="metric">
              {ops.docksOccupied} / {ops.docks} occupied
            </dd>
            <dt>Yard trucks</dt>
            <dd className="metric">{ops.trucks}</dd>
            <dt>Vehicles busy</dt>
            <dd className="metric">
              {ops.vehiclesBusy} / {ops.vehicles}
            </dd>
          </>
        )}
        {a && site.palletCapacity > 0 && (
          <>
            <dt>Pallets on hand</dt>
            <dd className="metric" data-testid="inspector-site-pallets">
              {a.pallets} / {site.palletCapacity}
            </dd>
          </>
        )}
        {a && site.containers && (
          <>
            <dt>Containers</dt>
            <dd className="metric" data-testid="inspector-site-containers">
              {a.containers} / {site.containers.capacity}
              {devanning > 0 ? ` · devanning (${formatTicks(config, devanning)})` : ""}
            </dd>
          </>
        )}
        {a && a.doors > 0 && (
          <>
            <dt>Doors in use</dt>
            <dd className="metric">
              {a.doorsBusy} / {a.doors}
            </dd>
          </>
        )}
        {a && a.stalls > 0 && (
          <>
            <dt>{site.kind === "fleet_depot" ? "Stalls & bays" : "Staging stalls"}</dt>
            <dd className="metric">
              {a.stallsBusy} / {a.stalls} occupied
            </dd>
          </>
        )}
        {a && (
          <>
            <dt>Received</dt>
            <dd className="metric">{a.received} pallets</dd>
            <dt>Dispatched</dt>
            <dd className="metric">{a.dispatched} pallets</dd>
          </>
        )}
      </Rows>
      {a && site.palletCapacity > 0 && (
        <OccupancyBar used={a.pallets} capacity={site.palletCapacity} />
      )}
      {a && Object.keys(a.bySku).length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px]">
          {Object.entries(a.bySku)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([sku, q]) => (
              <li key={sku} className="flex items-center gap-1.5 text-fog-300">
                <SkuSwatch config={config} sku={sku} />
                <span className="flex-1 truncate">
                  {config.skus.find((s) => s.id === sku)?.name ?? sku}
                </span>
                <span className="metric">{q}</span>
              </li>
            ))}
        </ul>
      )}
      {a && a.trucksHere.length > 0 && (
        <p className="mt-2 text-[11px] text-fog-400">
          Trucks here:{" "}
          {a.trucksHere.map((t, i) => (
            <span key={t}>
              {i > 0 && ", "}
              <button
                type="button"
                className="metric text-fog-200 underline-offset-2 hover:underline"
                onClick={() => select({ kind: "linehaul", id: t })}
              >
                {t}
              </button>
            </span>
          ))}
        </p>
      )}
      {active.length > 0 && (
        <div className="mt-3">
          <p className="panel-title">Transfers</p>
          <ul className="mt-1 space-y-1" data-testid="site-transfers">
            {active.slice(0, 6).map((t) => (
              <TransferRow key={t.id} t={t} config={config} here={id} />
            ))}
          </ul>
        </div>
      )}
      {ships && config.network && <RequestTransfer config={config} from={id} />}
    </Shell>
  );
}

export function LinehaulInspector({ id }: { id: string }) {
  const config = useSimulation((s) => s.config);
  const state = useSimulation((s) => s.state);
  const tick = useSimulation((s) => s.tick);
  const select = useSimulation((s) => s.select);
  const v = state.network?.vehicles[id];
  const label = config.network?.vehicles.find((x) => x.id === id)?.label ?? "Line-haul truck";
  if (!v) return null;
  const t = v.transfer_id ? state.network?.transfers[v.transfer_id] : undefined;
  const total = t ? cargoTotal(t.lines) : 0;
  const handling = v.status === "loading" || v.status === "unloading";
  const where = v.site_id
    ? siteName(config, v.site_id)
    : v.route[0]
      ? `${v.node} → ${v.route[0]}`
      : v.node;
  const sinceService = (v.odometer_mm - v.service_odometer_mm) / 1_000_000;
  return (
    <Shell title={id} subtitle={label}>
      <Rows>
        <dt>Status</dt>
        <dd data-testid="inspector-status">{LINEHAUL_STATUS_LABEL[v.status]}</dd>
        <dt>For</dt>
        <dd className="metric">{formatTicks(config, tick - v.status_since_tick)}</dd>
        <dt>Where</dt>
        <dd className="metric" title={where}>
          {where}
        </dd>
        <dt>On board</dt>
        <dd className="metric" data-testid="inspector-linehaul-cargo">
          {cargoTotal(v.cargo)} pallets
        </dd>
        {t && (
          <>
            <dt>Transfer</dt>
            <dd className="metric" data-testid="inspector-linehaul-transfer">
              {t.id} · {t.status.replace("_", " ")}
            </dd>
            <dt>Route</dt>
            <dd>
              {siteName(config, t.from_site)} → {siteName(config, t.to_site)}
            </dd>
          </>
        )}
        {handling && (
          <>
            <dt>Handled</dt>
            <dd className="metric">
              {v.handled} / {total} pallets
            </dd>
          </>
        )}
        {v.dc_truck_id && (
          <>
            <dt>DC truck</dt>
            <dd className="metric">
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => select({ kind: "truck", id: v.dc_truck_id as string })}
              >
                {v.dc_truck_id}
              </button>
            </dd>
          </>
        )}
        <dt>Odometer</dt>
        <dd className="metric">{(v.odometer_mm / 1_000_000).toFixed(2)} km</dd>
        <dt>Since service</dt>
        <dd className="metric">
          {sinceService.toFixed(2)} /{" "}
          {((config.network?.service_interval_mm ?? 0) / 1_000_000).toFixed(0)} km
        </dd>
      </Rows>
      {handling && <OccupancyBar used={v.handled} capacity={total} />}
      {t && (
        <ul className="mt-2 space-y-0.5 text-[11px]">
          {t.lines.map((l) => (
            <li key={l.sku} className="flex items-center gap-1.5 text-fog-300">
              <SkuSwatch config={config} sku={l.sku} />
              <span className="flex-1 truncate">
                {config.skus.find((s) => s.id === l.sku)?.name ?? l.sku}
              </span>
              <span className="metric">{l.quantity}</span>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
