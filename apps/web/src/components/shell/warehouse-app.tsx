"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { AnalyticsDashboard } from "@/components/analytics/analytics-dashboard";
import { CameraToolbar } from "@/components/panels/camera-toolbar";
import { InspectorPanel } from "@/components/panels/inspector-panel";
import { KpiBar } from "@/components/panels/kpi-bar";
import { NetworkPanel } from "@/components/panels/network-panel";
import { OperationsPanel } from "@/components/panels/operations-panel";
import { RendererPanel } from "@/components/panels/renderer-panel";
import { ScenarioPicker } from "@/components/panels/scenario-picker";
import { SimulationPanel } from "@/components/panels/simulation-panel";
import { SiteNavigator } from "@/components/panels/site-navigator";
import { SystemStatus } from "@/components/panels/system-status";
import { scenarioFromSearch, SPEED_PRESETS, useSimulation } from "@/lib/sim/store";
import { useModeRoute } from "@/lib/navigation/mode-route";
import { useSimulationLoop } from "@/lib/sim/use-simulation-loop";
import { qualityFromSearch, useView, type CameraPreset } from "@/lib/world/view-store";
import { EmptyStockNotice, SceneErrorBoundary, SceneStatusOverlay } from "./scene-states";
import { SiteLabelsOverlay } from "./site-labels";
import { TopBar } from "./top-bar";

// WebGL only exists in the browser; the status overlay covers the canvas until it is ready.
const SceneCanvas = dynamic(() => import("@/components/viewport/scene-canvas"), { ssr: false });

const CAMERA_KEYS: Record<string, CameraPreset> = {
  w: "world",
  o: "overview",
  d: "docks",
  a: "aisle",
  t: "top",
  f: "focus",
};

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const sim = useSimulation.getState();
      const camera = CAMERA_KEYS[e.key.toLowerCase()];
      if (e.code === "Space") {
        e.preventDefault();
        sim.togglePause();
      } else if (e.key === ".") sim.stepOnce();
      else if (e.key === "Escape") sim.select(null);
      else if (/^[1-5]$/.test(e.key)) sim.setSpeed(SPEED_PRESETS[Number(e.key) - 1] ?? 1);
      else if (camera === "world" && !sim.config.network) return;
      else if (camera && (camera !== "focus" || sim.selection))
        useView.getState().requestCamera(camera);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useUrlOptions() {
  useEffect(() => {
    const scenario = scenarioFromSearch(window.location.search);
    if (scenario && scenario !== useSimulation.getState().scenarioId)
      useSimulation.getState().loadScenario(scenario);
    const quality = qualityFromSearch(window.location.search);
    if (quality) useView.getState().setQualityMode(quality);
  }, []);
}

/**
 * The DC's operations console in Operate mode and in the DC's facility view; the network panel
 * everywhere else.
 */
function LeftPanel() {
  const network = useSimulation((s) => s.config.network);
  const scope = useView((s) => s.scope);
  const mode = useView((s) => s.mode);
  if (
    !network ||
    mode === "operate" ||
    (scope.kind === "site" && scope.siteId === network.primary_site)
  )
    return <OperationsPanel />;
  return <NetworkPanel />;
}

export function WarehouseApp() {
  useUrlOptions();
  useModeRoute();
  useSimulationLoop();
  useKeyboardShortcuts();
  const status = useView((s) => s.status.kind);
  const mode = useView((s) => s.mode);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-ink-950" data-world-status={status}>
      <div className="absolute inset-0">
        <SceneErrorBoundary>
          <SceneCanvas />
        </SceneErrorBoundary>
      </div>
      <SiteLabelsOverlay />
      <SceneStatusOverlay />

      {mode === "analytics" ? (
        // Analytics covers the 3D view (which stops rendering frames meanwhile); the simulation
        // keeps running underneath and the world is back as it was when another mode is chosen.
        <div
          className="absolute inset-0 flex flex-col gap-3 overflow-y-auto bg-ink-950 p-3 sm:p-4"
          data-testid="analytics-view"
        >
          <TopBar />
          <AnalyticsDashboard />
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 flex flex-col gap-2 p-3 sm:gap-3 sm:p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-2">
              <TopBar />
              <KpiBar />
              <SiteNavigator />
            </div>
            <div className="hidden sm:block">
              <ScenarioPicker />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-start justify-end gap-3">
            <LeftPanel />
            <InspectorPanel />
            <CameraToolbar />
          </div>
          <EmptyStockNotice />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
            <SimulationPanel />
            <div className="flex flex-col items-start gap-3 sm:items-end">
              <div className="hidden sm:block">
                <SystemStatus />
              </div>
              <RendererPanel />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
