"use client";

import { useEffect } from "react";
import { useSimulation } from "../sim/store";
import { useView } from "../world/view-store";
import { modeFromSearch, searchWithMode, type AppMode } from "./modes";

/**
 * Open a mode: record it (view store and `?mode=` in the URL) and move the camera to the view
 * that mode works in. Operate runs the distribution centre, so it frames the DC; Explore opens on
 * the whole world (or the facility in a single-site scenario); Analytics covers the 3D view with
 * the dashboard and leaves the camera alone.
 */
export function openMode(mode: AppMode, history: "push" | "none" = "push"): void {
  useView.getState().setMode(mode);
  if (history === "push" && typeof window !== "undefined") {
    const search = searchWithMode(window.location.search, mode);
    if (search !== window.location.search)
      window.history.pushState(
        null,
        "",
        `${window.location.pathname}${search}${window.location.hash}`,
      );
  }
  // Analytics is a 2D view of published data: the camera stays where it was.
  if (mode === "analytics") return;
  const network = !!useSimulation.getState().config.network;
  useView.getState().requestCamera(mode === "explore" && network ? "world" : "overview");
}

/** Mode from the URL on load, and on back/forward navigation. */
export function useModeRoute(): void {
  useEffect(() => {
    // On load only record it: the camera rig frames the initial view for the mode itself.
    useView.getState().setMode(modeFromSearch(window.location.search));
    const onPop = () => openMode(modeFromSearch(window.location.search), "none");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
