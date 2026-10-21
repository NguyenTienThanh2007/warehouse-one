"use client";

import { useMemo } from "react";
import { useSimulation } from "@/lib/sim/store";
import { useView } from "@/lib/world/view-store";
import { resolveSites, SITE_KIND_LABEL } from "@/world/network-view";

const KIND_DOT: Record<string, string> = {
  distribution_center: "bg-signal-400",
  cross_dock: "bg-data-400",
  container_terminal: "bg-sky-400",
  fleet_depot: "bg-fog-400",
  gateway: "bg-emerald-400",
};

/**
 * World / facility navigation: the whole-network view, then one button per site. The current view
 * is highlighted (it follows the camera, so double-clicking a site in 3D updates it too).
 */
export function SiteNavigator() {
  const config = useSimulation((s) => s.config);
  const select = useSimulation((s) => s.select);
  const scope = useView((s) => s.scope);
  const requestCamera = useView((s) => s.requestCamera);
  const requestSite = useView((s) => s.requestSite);
  const sites = useMemo(() => (config.network ? resolveSites(config) : []), [config]);
  if (sites.length === 0) return null;
  const pill = (active: boolean) =>
    `flex items-center gap-1.5 whitespace-nowrap rounded-[9px] px-2.5 py-1 text-[11px] font-medium transition ${
      active ? "bg-white/10 text-fog-50" : "text-fog-400 hover:bg-white/5 hover:text-fog-200"
    }`;
  return (
    <nav
      aria-label="Sites"
      className="panel pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto p-1 [scrollbar-width:none]"
      data-testid="site-navigator"
      data-scope={scope.kind === "world" ? "world" : scope.siteId}
    >
      <button
        type="button"
        className={pill(scope.kind === "world")}
        aria-pressed={scope.kind === "world"}
        onClick={() => requestCamera("world")}
        data-testid="nav-world"
        title="Whole logistics network (W)"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
        </svg>
        World
      </button>
      <span className="mx-0.5 h-4 w-px bg-white/10" aria-hidden="true" />
      {sites.map((s) => {
        const active = scope.kind === "site" && scope.siteId === s.id;
        return (
          <button
            key={s.id}
            type="button"
            className={pill(active)}
            aria-pressed={active}
            title={SITE_KIND_LABEL[s.kind]}
            onClick={() => {
              select({ kind: "site", id: s.id });
              requestSite(s.id);
            }}
            data-testid={`nav-site-${s.id}`}
          >
            <span
              className={`size-1.5 rounded-full ${KIND_DOT[s.kind] ?? "bg-fog-400"}`}
              aria-hidden="true"
            />
            {s.name}
          </button>
        );
      })}
    </nav>
  );
}
