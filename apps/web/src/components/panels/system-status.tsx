"use client";

import type { RecorderStatus } from "@warehouse-one/recorder";
import { useEffect, useState } from "react";
import { API_URL, fetchApiStatus, type ApiStatus } from "@/lib/api/health";
import { useSimulation } from "@/lib/sim/store";

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
      className="panel pointer-events-auto px-3.5 py-2.5"
      data-testid="api-status"
      data-status={status.kind}
    >
      <div className="flex items-center gap-3">
        <span className={`size-2 rounded-full ${style.dot}`} aria-hidden="true" />
        <div className="leading-tight">
          <p className="text-xs font-medium">
            API <span className="text-fog-400">{style.label}</span>
          </p>
          <p className="metric text-[11px] text-fog-500">{detail}</p>
        </div>
      </div>
      <RecordingControl />
    </section>
  );
}

const RECORDING_LABEL: Record<RecorderStatus["state"], string> = {
  idle: "Recording",
  sending: "Recording",
  retrying: "Retrying",
  failed: "Rejected",
  stopped: "Stopped",
};

/**
 * Opt-in recording of the current run to the API (event store → outbox → pipeline). Turning it on
 * restarts the scenario as a new run with its own simulation_id.
 */
function RecordingControl() {
  const recording = useSimulation((s) => s.recording);
  const setRecording = useSimulation((s) => s.setRecording);
  const on = recording !== null && recording.state !== "stopped";
  return (
    <div
      className="mt-2 flex items-center justify-between gap-3 border-t border-white/5 pt-2"
      data-testid="recording"
      data-state={recording?.state ?? "off"}
    >
      <div className="min-w-0 leading-tight">
        <p className="text-[11px] text-fog-200">
          {recording ? RECORDING_LABEL[recording.state] : "Not recording"}
          {recording && (
            <span className="metric ml-1 text-fog-500" data-testid="recording-stored">
              · {recording.sentEvents.toLocaleString("en-US")} events stored
              {recording.pendingEvents ? ` · ${recording.pendingEvents} pending` : ""}
            </span>
          )}
        </p>
        {recording?.lastError && (
          <p className="truncate text-[11px] text-critical-400" title={recording.lastError.message}>
            {recording.lastError.code}: {recording.lastError.message}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => setRecording(!on)}
        aria-pressed={on}
        data-testid="recording-toggle"
        title={
          on
            ? "Stop sending this run to the API"
            : "Restart the scenario as a new run and record it to the API"
        }
        className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-[11px] text-fog-200 hover:bg-white/5"
      >
        {on ? "Stop" : "Record run"}
      </button>
    </div>
  );
}
