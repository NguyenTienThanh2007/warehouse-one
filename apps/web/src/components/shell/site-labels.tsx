"use client";

import { useMemo } from "react";
import { useSimulation } from "@/lib/sim/store";
import { registerSiteLabel } from "@/lib/world/site-labels";
import { useView } from "@/lib/world/view-store";
import { resolveSites, SITE_KIND_LABEL, siteActivity, type SiteView } from "@/world/network-view";

/**
 * Site labels over the 3D world: name, kind and one live figure. Clicking one selects the site and
 * flies the camera to it. Positioned every frame by `SiteLabelProjector` inside the canvas.
 */
export function SiteLabelsOverlay() {
  const config = useSimulation((s) => s.config);
  const sites = useMemo(() => (config.network ? resolveSites(config) : []), [config]);
  if (sites.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="site-labels">
      {sites.map((s) => (
        <SiteLabel key={s.id} site={s} />
      ))}
    </div>
  );
}

function SiteLabel({ site }: { site: SiteView }) {
  const config = useSimulation((s) => s.config);
  const state = useSimulation((s) => s.state);
  const select = useSimulation((s) => s.select);
  const requestSite = useView((s) => s.requestSite);
  const a = siteActivity(config, state, site.id);
  const figure = site.primary
    ? `${Object.keys(state.ops?.pallets ?? {}).length} pallets · ${
        Object.values(state.ops?.docks ?? {}).filter((d) => d.truck_id).length
      }/${config.facility?.docks.length ?? 0} docks`
    : site.kind === "container_terminal"
      ? `${a?.containers ?? 0} containers · ${a?.pallets ?? 0} pallets`
      : site.kind === "cross_dock"
        ? `${a?.pallets ?? 0} pallets · ${a?.doorsBusy ?? 0}/${a?.doors ?? 0} doors`
        : site.kind === "fleet_depot"
          ? `${a?.trucksHere.length ?? 0} trucks on site`
          : `${a?.received ?? 0} pallets to last mile`;
  return (
    <button
      type="button"
      ref={(el) => registerSiteLabel(site.id, el)}
      data-testid={`site-label-${site.id}`}
      onClick={() => {
        select({ kind: "site", id: site.id });
        requestSite(site.id);
      }}
      style={{ visibility: "hidden" }}
      className="pointer-events-auto absolute left-0 top-0 whitespace-nowrap rounded-lg border border-white/10 bg-ink-900/80 px-2.5 py-1.5 text-left shadow-lg backdrop-blur transition-colors hover:border-signal-400/60"
    >
      <span className="block text-[9px] font-semibold uppercase tracking-[0.14em] text-signal-300">
        {SITE_KIND_LABEL[site.kind]}
      </span>
      <span className="block text-xs font-semibold text-fog-50">{site.name}</span>
      <span className="metric block text-[10px] text-fog-400">{figure}</span>
    </button>
  );
}
