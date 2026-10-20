"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { InspectorPanel } from "@/components/panels/inspector-panel";
import { RendererPanel } from "@/components/panels/renderer-panel";
import { SimulationPanel } from "@/components/panels/simulation-panel";
import { SystemStatus } from "@/components/panels/system-status";
import { createFoundationDemoConfig } from "@warehouse-one/simulation";
import { layoutFromSearch, SPEED_PRESETS, useSimulation } from "@/lib/sim/store";
import { useSimulationLoop } from "@/lib/sim/use-simulation-loop";
import { TopBar } from "./top-bar";

// WebGL only exists in the browser; render a stable placeholder on the server.
const SceneCanvas = dynamic(() => import("@/components/viewport/scene-canvas"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-sm text-fog-500" role="status">
      Initializing renderer…
    </div>
  ),
});

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const sim = useSimulation.getState();
      if (e.code === "Space") {
        e.preventDefault();
        sim.togglePause();
      } else if (e.key === ".") sim.stepOnce();
      else if (e.key === "Escape") sim.select(null);
      else if (/^[1-5]$/.test(e.key)) sim.setSpeed(SPEED_PRESETS[Number(e.key) - 1] ?? 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useScenarioFromUrl() {
  useEffect(() => {
    const layout = layoutFromSearch(window.location.search);
    if (layout) useSimulation.getState().loadScenario(createFoundationDemoConfig(layout));
  }, []);
}

export function WarehouseApp() {
  useScenarioFromUrl();
  useSimulationLoop();
  useKeyboardShortcuts();

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-ink-950">
      <div className="absolute inset-0">
        <SceneCanvas />
      </div>

      <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 p-3 sm:p-4">
        <TopBar />
        <div className="flex min-h-0 flex-1 items-start justify-end">
          <InspectorPanel />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <SimulationPanel />
          <div className="flex flex-col items-start gap-3 sm:items-end">
            <SystemStatus />
            <RendererPanel />
          </div>
        </div>
      </div>
    </main>
  );
}
