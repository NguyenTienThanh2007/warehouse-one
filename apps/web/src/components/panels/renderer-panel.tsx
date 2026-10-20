"use client";

import { useEffect, useState } from "react";
import type { FrameSummary } from "@/lib/perf/frame-stats";
import { frameStats, rendererInfo, type RendererInfo } from "@/lib/perf/renderer-probe";
import { useView, type QualityMode } from "@/lib/world/view-store";

export function RendererPanel() {
  const qualityMode = useView((v) => v.qualityMode);
  const tier = useView((v) => v.tier);
  const setQualityMode = useView((v) => v.setQualityMode);
  const [stats, setStats] = useState<{ frame: FrameSummary | null; info: RendererInfo }>({
    frame: null,
    info: rendererInfo,
  });

  useEffect(() => {
    const id = setInterval(
      () => setStats({ frame: frameStats.summary(), info: { ...rendererInfo } }),
      500,
    );
    return () => clearInterval(id);
  }, []);

  const f = stats.frame;
  const fpsTone = !f
    ? "text-fog-400"
    : f.fps >= 55
      ? "text-ok-400"
      : f.fps >= 30
        ? "text-warn-400"
        : "text-critical-400";

  return (
    <section
      aria-label="Renderer performance"
      className="panel pointer-events-auto hidden px-3.5 py-2.5 sm:block"
      data-testid="renderer-panel"
    >
      <dl className="metric grid grid-cols-4 gap-x-4 text-[11px]">
        <div>
          <dt className="text-fog-500">FPS</dt>
          <dd className={`text-sm ${fpsTone}`}>{f ? f.fps.toFixed(0) : "–"}</dd>
        </div>
        <div>
          <dt className="text-fog-500">p95 ms</dt>
          <dd className="text-sm text-fog-200">{f ? f.p95Ms.toFixed(1) : "–"}</dd>
        </div>
        <div>
          <dt className="text-fog-500">draws</dt>
          <dd className="text-sm text-fog-200">{stats.info.drawCalls}</dd>
        </div>
        <div>
          <dt className="text-fog-500">tris</dt>
          <dd className="text-sm text-fog-200">{stats.info.triangles.toLocaleString("en-US")}</dd>
        </div>
      </dl>
      <label className="mt-2 flex items-center justify-between gap-3 border-t border-white/5 pt-2 text-[11px] text-fog-400">
        <span>
          Quality{" "}
          <span className="metric text-fog-200" data-testid="quality-tier">
            {tier}
          </span>
        </span>
        <select
          value={qualityMode}
          onChange={(e) => setQualityMode(e.target.value as QualityMode)}
          data-testid="quality-mode"
          className="rounded-md bg-ink-800 px-1.5 py-0.5 text-fog-50"
        >
          <option value="auto">Auto</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </label>
    </section>
  );
}
