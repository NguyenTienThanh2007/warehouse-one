"use client";

import type { ApiFailure } from "@/lib/api/request";
import { API_URL, API_URL_SOURCE } from "@/lib/api/health";
import type { FailedOperation } from "@/lib/twin/store";
import type { Tone } from "@/lib/twin/view";

/** Shared building blocks of the AI workspace, in the dark control-tower style of Analytics. */

export const TONE_CLASS: Record<Tone, string> = {
  ok: "border-ok-400/30 bg-ok-400/10 text-ok-400",
  warn: "border-warn-400/40 bg-warn-400/10 text-warn-400",
  critical: "border-critical-400/40 bg-critical-400/10 text-critical-400",
  info: "border-data-400/30 bg-data-400/10 text-data-300",
  muted: "border-white/10 bg-white/5 text-fog-200",
};

export function Badge({
  tone,
  children,
  testid,
  title,
}: {
  tone: Tone;
  children: React.ReactNode;
  testid?: string;
  title?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${TONE_CLASS[tone]}`}
      data-testid={testid}
      title={title}
    >
      {children}
    </span>
  );
}

/** Where a value comes from: measured live, simulated by the optimiser, checked by the API, or AI. */
export const PROVENANCE = {
  live: { tone: "ok" as Tone, label: "Live · measured from the running simulation" },
  simulated: { tone: "info" as Tone, label: "Simulated prediction · deterministic optimiser" },
  server: { tone: "muted" as Tone, label: "Checked by the API" },
  ai: { tone: "warn" as Tone, label: "AI-generated · not a measurement" },
};

export function Provenance({ kind, testid }: { kind: keyof typeof PROVENANCE; testid?: string }) {
  const p = PROVENANCE[kind];
  return (
    <Badge tone={p.tone} testid={testid ?? `twin-provenance-${kind}`}>
      {p.label}
    </Badge>
  );
}

export function Panel({
  title,
  subtitle,
  aside,
  children,
  testid,
  className = "",
}: {
  title: string;
  subtitle?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  testid: string;
  className?: string;
}) {
  const id = `${testid}-title`;
  return (
    <section className={`panel p-4 ${className}`} data-testid={testid} aria-labelledby={id}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={id} className="text-sm font-semibold text-fog-50">
            {title}
          </h3>
          {subtitle && <p className="mt-0.5 text-[11px] leading-4 text-fog-400">{subtitle}</p>}
        </div>
        {aside && <div className="flex flex-wrap items-center gap-1.5">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  testid,
  busy,
  type = "button",
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  testid?: string;
  busy?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const style = {
    primary: "bg-signal-400 text-ink-950 hover:bg-signal-300",
    secondary: "border border-white/15 bg-white/5 text-fog-50 hover:bg-white/10",
    danger:
      "border border-critical-400/40 bg-critical-400/10 text-critical-400 hover:bg-critical-400/20",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      title={title}
      className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${style}`}
      data-testid={testid}
    >
      {children}
    </button>
  );
}

const FAILURE_TITLE: Record<ApiFailure["kind"], string> = {
  offline: "API unreachable",
  blocked: "The API refused this page (CORS)",
  mismatch: "Wrong API or API version",
  http: "The API answered with an error",
  contract: "Unexpected answer from the API",
};

/** A failed operation, what went wrong, and a retry of exactly that operation. */
export function FailureNotice({
  failed,
  busy,
  onDismiss,
}: {
  failed: FailedOperation;
  busy: boolean;
  onDismiss?: () => void;
}) {
  const f = failed.failure;
  const detail =
    f.kind === "api"
      ? `${FAILURE_TITLE[f.failure.kind]}${f.failure.kind === "http" ? ` (${f.failure.status} ${f.failure.code})` : ""}: ${f.failure.message}`
      : f.message;
  const network = f.kind === "api" && ["offline", "blocked", "mismatch"].includes(f.failure.kind);
  return (
    <div
      className="panel flex flex-wrap items-start justify-between gap-3 border border-critical-400/40 bg-critical-400/10 px-4 py-3"
      role="alert"
      data-testid="twin-failure"
      data-op={failed.op}
      data-kind={f.kind === "api" ? f.failure.kind : f.code}
    >
      <div className="min-w-0 text-xs">
        <p className="font-semibold text-fog-50">{failed.title}</p>
        <p className="mt-0.5 text-fog-200">{detail}</p>
        {network && (
          <p className="mt-1 text-[11px] text-fog-400">
            API URL <span className="metric text-fog-200">{API_URL}</span> (from {API_URL_SOURCE}).
            Start it with <code className="text-fog-200">docker compose up -d --wait</code>; the
            optimiser and what-if comparisons still run here without it.
          </p>
        )}
      </div>
      <div className="flex gap-2">
        {failed.retry && (
          <Button testid="twin-retry" busy={busy} onClick={() => void failed.retry?.()}>
            {busy ? "Retrying…" : "Retry"}
          </Button>
        )}
        {onDismiss && (
          <Button variant="secondary" onClick={onDismiss} testid="twin-dismiss">
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

/** An inline confirmation for a consequential action; the confirm button takes the focus. */
export function Confirm({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  variant = "primary",
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "primary" | "danger";
}) {
  return (
    <div
      role="alertdialog"
      aria-labelledby="twin-confirm-title"
      className="rounded-lg border border-signal-400/40 bg-ink-850 p-3"
      data-testid="twin-confirm"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <p id="twin-confirm-title" className="text-xs font-semibold text-fog-50">
        {title}
      </p>
      <div className="mt-1 text-[11px] leading-4 text-fog-200">{children}</div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          // Focus moves into the confirmation the operator just opened.
          autoFocus
          onClick={onConfirm}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold ${variant === "danger" ? "bg-critical-400 text-ink-950" : "bg-signal-400 text-ink-950 hover:bg-signal-300"}`}
          data-testid="twin-confirm-yes"
        >
          {confirmLabel}
        </button>
        <Button variant="secondary" onClick={onCancel} testid="twin-confirm-no">
          Cancel
        </Button>
      </div>
    </div>
  );
}
