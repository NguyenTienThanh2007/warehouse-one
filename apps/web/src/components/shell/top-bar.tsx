const MODES = [
  { id: "explore", label: "Explore", phase: 1, active: true },
  { id: "build", label: "Build", phase: 2 },
  { id: "operate", label: "Operate", phase: 2 },
  { id: "analytics", label: "Analytics", phase: 4 },
  { id: "ai", label: "AI", phase: 5 },
] as const;

export function TopBar() {
  return (
    <header className="pointer-events-auto flex flex-wrap items-center gap-3">
      <div className="panel flex items-center gap-3 px-4 py-2.5">
        <Logo />
        <div className="leading-tight">
          <h1 className="text-[13px] font-semibold tracking-[0.18em]">WAREHOUSE ONE</h1>
          <p className="hidden text-[11px] text-fog-400 sm:block">
            Intelligent Logistics. Living Data.
          </p>
        </div>
        <span className="ml-1 rounded-full border border-signal-400/30 bg-signal-400/10 px-2 py-0.5 text-[11px] font-medium text-signal-300">
          Phase 2 · Live operations
        </span>
      </div>

      <nav aria-label="Modes" className="panel hidden items-center gap-1 p-1 md:flex">
        {MODES.map((m) =>
          "active" in m ? (
            <span
              key={m.id}
              aria-current="page"
              className="rounded-[10px] bg-ink-700 px-3 py-1.5 text-xs font-medium text-fog-50"
            >
              {m.label}
            </span>
          ) : (
            <button
              key={m.id}
              type="button"
              disabled
              title={`${m.label} mode arrives in Phase ${m.phase}`}
              className="cursor-not-allowed rounded-[10px] px-3 py-1.5 text-xs text-fog-500"
            >
              {m.label}
              <span className="ml-1.5 text-[11px] text-fog-500/70">P{m.phase}</span>
            </button>
          ),
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
