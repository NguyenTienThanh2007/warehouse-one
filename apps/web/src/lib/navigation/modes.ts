/**
 * Product modes (docs/product/PRD.md §4) and their real status in this codebase. The top bar, the
 * URL (`?mode=`) and the tests all read this list, so a mode is only offered as available when
 * the view it opens exists.
 */

export type ModeId = "explore" | "operate" | "build" | "analytics" | "ai";

/** Modes with a working view; `?mode=` accepts only these. */
export const AVAILABLE_MODES = ["explore", "operate", "analytics", "ai"] as const;
export type AppMode = (typeof AVAILABLE_MODES)[number];

export type ModeInfo =
  | {
      readonly id: AppMode;
      readonly label: string;
      readonly status: "available";
      /** What the mode shows (tooltip). */
      readonly summary: string;
    }
  | {
      readonly id: Exclude<ModeId, AppMode>;
      readonly label: string;
      readonly status: "planned";
      /** Where it is on the roadmap, e.g. "Phase 4", or "Not scheduled". */
      readonly plan: string;
      readonly summary: string;
      /** What exists today and what does not (shown in the coming-soon notice). */
      readonly detail: string;
    };

export const MODES: readonly ModeInfo[] = [
  {
    id: "explore",
    label: "Explore",
    status: "available",
    summary: "Navigate the logistics world and inspect any site, rack bay, vehicle or truck.",
  },
  {
    id: "operate",
    label: "Operate",
    status: "available",
    summary:
      "Operator console for the distribution centre: tasks, orders, trucks and new work (orders, inbound trucks), with run controls.",
  },
  {
    id: "build",
    label: "Build",
    status: "planned",
    plan: "Not scheduled",
    summary: "Layout design: place, move and remove racks, docks and zones.",
    detail:
      "Layout editing is not built. Facility layouts come from the scenario configuration and cannot be changed in the app yet.",
  },
  {
    id: "analytics",
    label: "Analytics",
    status: "available",
    summary:
      "Published analytics of recorded runs: throughput, task and order flow, pallet flows, transfers and data quality, with freshness and pipeline health.",
  },
  {
    id: "ai",
    label: "AI",
    status: "available",
    summary:
      "Fleet decision support: a deterministic optimiser and what-if simulations propose where idle line-haul trucks wait; you review, approve and apply, with optional AI explanations.",
  },
];

export function isAppMode(value: string | null): value is AppMode {
  return value !== null && (AVAILABLE_MODES as readonly string[]).includes(value);
}

/** The mode a URL asks for; anything else (absent, unknown, planned) is Explore. */
export function modeFromSearch(search: string): AppMode {
  const value = new URLSearchParams(search).get("mode");
  return isAppMode(value) ? value : "explore";
}

/** The query string for a mode, keeping every other parameter (Explore is the default: no param). */
export function searchWithMode(search: string, mode: AppMode): string {
  const params = new URLSearchParams(search);
  if (mode === "explore") params.delete("mode");
  else params.set("mode", mode);
  const s = params.toString();
  return s ? `?${s}` : "";
}
