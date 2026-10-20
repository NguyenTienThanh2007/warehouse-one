"use client";

import { useEffect, useState } from "react";
import type { FrameSummary } from "@/lib/perf/frame-stats";
import { frameStats, rendererInfo, type RendererInfo } from "@/lib/perf/renderer-probe";

export function RendererPanel() {
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
    </section>
  );
}
