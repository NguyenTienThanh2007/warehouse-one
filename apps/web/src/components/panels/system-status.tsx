"use client";

import { useEffect, useState } from "react";
import { API_URL, fetchApiStatus, type ApiStatus } from "@/lib/api/health";

const POLL_MS = 15_000;

const STYLE: Record<ApiStatus["kind"], { dot: string; label: string }> = {
  checking: { dot: "bg-fog-500 animate-pulse", label: "Checking…" },
  online: { dot: "bg-ok-400", label: "Online" },
  degraded: { dot: "bg-warn-400", label: "Degraded" },
  offline: { dot: "bg-critical-400", label: "Offline" },
};

export function SystemStatus() {
  const [status, setStatus] = useState<ApiStatus>({ kind: "checking" });

  useEffect(() => {
    let active = true;
    const check = () => fetchApiStatus().then((s) => active && setStatus(s));
    void check();
    const id = setInterval(check, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const style = STYLE[status.kind];
  const detail =
    status.kind === "online"
      ? `v${status.version} · ${status.latencyMs} ms · database ok`
      : status.kind === "degraded"
        ? `v${status.version} · database unavailable`
        : status.kind === "offline"
          ? `${status.reason} · simulation keeps running locally`
          : API_URL;

  return (
    <section
      aria-label="Backend status"
      className="panel pointer-events-auto flex items-center gap-3 px-3.5 py-2.5"
      data-testid="api-status"
      data-status={status.kind}
    >
      <span className={`size-2 rounded-full ${style.dot}`} aria-hidden="true" />
      <div className="leading-tight">
        <p className="text-xs font-medium">
          API <span className="text-fog-400">{style.label}</span>
        </p>
        <p className="metric text-[10px] text-fog-500">{detail}</p>
      </div>
    </section>
  );
}
