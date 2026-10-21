"use client";

import { useSimulation } from "@/lib/sim/store";
import { useView, type CameraPreset } from "@/lib/world/view-store";

const BUTTONS: {
  preset: CameraPreset;
  label: string;
  key: string;
  icon: string;
  network?: boolean;
}[] = [
  {
    preset: "world",
    label: "World overview",
    key: "W",
    icon: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18",
    network: true,
  },
  { preset: "overview", label: "DC overview", key: "O", icon: "M3 9l9-6 9 6-9 6-9-6zm0 6l9 6 9-6" },
  { preset: "docks", label: "Docks", key: "D", icon: "M3 21V9l9-6 9 6v12M8 21v-6h8v6" },
  { preset: "aisle", label: "Aisle", key: "A", icon: "M5 3v18M19 3v18M9 7h6M9 12h6M9 17h6" },
  { preset: "top", label: "Plan view", key: "T", icon: "M4 4h16v16H4zM4 12h16M12 4v16" },
  {
    preset: "focus",
    label: "Focus selection",
    key: "F",
    icon: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M12 12m-2.5 0a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0",
  },
];

export function CameraToolbar() {
  const requestCamera = useView((s) => s.requestCamera);
  const hasSelection = useSimulation((s) => s.selection !== null);
  const hasNetwork = useSimulation((s) => !!s.config.network);
  return (
    <nav
      aria-label="Camera"
      className="panel pointer-events-auto flex flex-col gap-1 p-1"
      data-testid="camera-toolbar"
    >
      {BUTTONS.filter((b) => !b.network || hasNetwork).map((b) => {
        const disabled = b.preset === "focus" && !hasSelection;
        return (
          <button
            key={b.preset}
            type="button"
            disabled={disabled}
            onClick={() => requestCamera(b.preset)}
            title={`${b.label} (${b.key})`}
            aria-label={`${b.label} (${b.key})`}
            data-testid={`camera-${b.preset}`}
            className="grid size-9 place-items-center rounded-[10px] text-fog-200 transition hover:bg-white/8 hover:text-fog-50 disabled:opacity-30"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={b.icon} />
            </svg>
          </button>
        );
      })}
    </nav>
  );
}
