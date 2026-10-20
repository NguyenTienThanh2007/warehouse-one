"use client";

import { Component, type ReactNode } from "react";
import { stockSummary, useSimulation } from "@/lib/sim/store";
import { useView } from "@/lib/world/view-store";

/** Catches renderer failures (e.g. WebGL unavailable) and shows a recoverable error state. */
export class SceneErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  override state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown) {
    useView
      .getState()
      .setStatus({ kind: "error", reason: error instanceof Error ? error.message : String(error) });
  }

  override render() {
    return this.state.error ? null : this.props.children;
  }
}

export function SceneStatusOverlay() {
  const status = useView((s) => s.status);
  if (status.kind === "ready") return null;

  if (status.kind === "error") {
    const webgl = /webgl|context/i.test(status.reason);
    return (
      <div
        className="absolute inset-0 grid place-items-center bg-ink-950/80 p-6"
        role="alert"
        data-testid="scene-error"
      >
        <div className="panel max-w-md p-6 text-center">
          <p className="panel-title">3D view unavailable</p>
          <p className="mt-3 text-sm text-fog-200">
            {webgl
              ? "This browser could not start WebGL, which the 3D warehouse needs. Enable hardware acceleration or try a current version of Chrome, Edge, Firefox or Safari."
              : "The 3D view stopped because of an unexpected error."}
          </p>
          <p className="metric mt-2 text-[11px] break-words text-fog-500">{status.reason}</p>
          <p className="mt-3 text-xs text-fog-400">
            The simulation and panels keep working without it.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-signal-400 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-signal-300"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 grid place-items-center bg-ink-950 transition-opacity"
      role="status"
      data-testid="scene-loading"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="h-1 w-40 overflow-hidden rounded-full bg-ink-700">
          <div className="h-full w-1/3 animate-[loading_1.1s_ease-in-out_infinite] rounded-full bg-signal-400" />
        </div>
        <p className="text-xs text-fog-400">Building the warehouse…</p>
      </div>
    </div>
  );
}

/** Explains an empty facility instead of showing a silent, empty building. */
export function EmptyStockNotice() {
  const config = useSimulation((s) => s.config);
  const inventory = useSimulation((s) => s.inventory);
  const loadScenario = useSimulation((s) => s.loadScenario);
  const status = useView((s) => s.status);
  const { units, locations } = stockSummary(config, inventory);
  if (status.kind !== "ready" || units > 0) return null;
  return (
    <div
      className="pointer-events-auto panel mx-auto max-w-sm px-4 py-3 text-center"
      data-testid="empty-state"
    >
      <p className="text-sm font-medium">
        {locations === 0 ? "No storage locations configured" : "No stock on hand"}
      </p>
      <p className="mt-1 text-xs text-fog-400">
        {locations === 0
          ? "This scenario has no rack bays to display."
          : "Racks are empty because the simulation holds no inventory. Load the showcase to start with opening stock."}
      </p>
      <button
        type="button"
        onClick={() => loadScenario("showcase")}
        className="mt-3 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-fog-200 hover:bg-white/5"
      >
        Load showcase
      </button>
    </div>
  );
}
