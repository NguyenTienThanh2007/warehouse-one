"use client";

import { useEffect, useRef, useState } from "react";
import { openMode } from "@/lib/navigation/mode-route";
import { MODES, type ModeInfo } from "@/lib/navigation/modes";
import { useView } from "@/lib/world/view-store";

type Planned = Extract<ModeInfo, { status: "planned" }>;

export function TopBar() {
  const mode = useView((s) => s.mode);
  const [notice, setNotice] = useState<Planned | null>(null);
  const navRef = useRef<HTMLElement>(null);

  // A notice closes on Escape or on a click anywhere outside the mode bar.
  useEffect(() => {
    if (!notice) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNotice(null);
    const onDown = (e: MouseEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setNotice(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [notice]);

  return (
    <header className="pointer-events-auto relative z-20 flex flex-wrap items-center gap-3">
      <div className="panel flex items-center gap-3 px-4 py-2.5">
        <Logo />
        <div className="leading-tight">
          <h1 className="text-[13px] font-semibold tracking-[0.18em]">WAREHOUSE ONE</h1>
          <p className="hidden text-[11px] text-fog-400 sm:block">
            Intelligent Logistics. Living Data.
          </p>
        </div>
        <span className="ml-1 rounded-full border border-signal-400/30 bg-signal-400/10 px-2 py-0.5 text-[11px] font-medium text-signal-300">
          Phase 6 · AI &amp; digital twin
        </span>
      </div>

      <nav
        ref={navRef}
        aria-label="Modes"
        className="panel relative hidden items-center gap-1 p-1 md:flex"
        data-testid="mode-nav"
        data-mode={mode}
      >
        {MODES.map((m) => {
          if (m.status === "available") {
            const active = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                aria-current={active ? "page" : undefined}
                title={m.summary}
                data-testid={`mode-${m.id}`}
                onClick={() => {
                  setNotice(null);
                  openMode(m.id);
                }}
                className={`rounded-[10px] px-3 py-1.5 text-xs font-medium transition ${
                  active
                    ? "bg-ink-700 text-fog-50"
                    : "text-fog-300 hover:bg-white/5 hover:text-fog-50"
                }`}
              >
                {m.label}
              </button>
            );
          }
          const open = notice?.id === m.id;
          return (
            <button
              key={m.id}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={open}
              data-status="planned"
              aria-controls={open ? "mode-notice" : undefined}
              title={`${m.label}: coming soon (${m.plan})`}
              data-testid={`mode-${m.id}`}
              onClick={() => setNotice(open ? null : m)}
              className={`rounded-[10px] px-3 py-1.5 text-xs transition ${
                open ? "bg-white/5 text-fog-300" : "text-fog-500 hover:text-fog-300"
              }`}
            >
              {m.label}
              <span className="ml-1.5 rounded-full border border-white/10 px-1.5 py-px text-[10px] text-fog-500">
                Soon
              </span>
            </button>
          );
        })}
        {notice && (
          <div
            id="mode-notice"
            role="dialog"
            aria-labelledby="mode-notice-title"
            data-testid="mode-notice"
            // Opaque: a backdrop blur does not reach through the mode bar's own blurred panel.
            style={{ background: "var(--color-ink-900)" }}
            className="panel absolute top-full right-0 z-10 mt-2 w-80 p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="panel-title">Coming soon · {notice.plan}</p>
                <p id="mode-notice-title" className="mt-1 text-sm font-semibold text-fog-50">
                  {notice.label}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="Close"
                className="rounded-md px-1.5 text-fog-400 hover:bg-white/5"
              >
                ×
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-fog-300">{notice.summary}</p>
            <p className="mt-2 text-xs leading-5 text-fog-400" data-testid="mode-notice-detail">
              {notice.detail}
            </p>
          </div>
        )}
      </nav>
    </header>
  );
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="24"
        height="24"
        rx="6"
        fill="#1a2029"
        stroke="rgb(255 255 255 / 0.1)"
      />
      <path
        d="M6 18V10l7-4 7 4v8"
        fill="none"
        stroke="#f5b83d"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M10 18v-4h6v4"
        fill="none"
        stroke="#3fb8af"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
