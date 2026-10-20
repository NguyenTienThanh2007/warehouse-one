"use client";

import { REJECTION_EXPLANATION, useSimulation, type CommandRecord } from "@/lib/sim/store";

const STATUS_STYLE: Record<CommandRecord["status"], string> = {
  pending: "text-fog-400",
  accepted: "text-data-300",
  rejected: "text-critical-400",
};

const STATUS_LABEL: Record<CommandRecord["status"], string> = {
  pending: "Queued",
  accepted: "Accepted",
  rejected: "Rejected",
};

/** One operator command and its outcome; rejections explain what happened and what to do. */
export function CommandResult({ record }: { record: CommandRecord }) {
  return (
    <li
      className="rounded-md bg-ink-800/70 px-2 py-1.5 text-[11px] leading-4"
      data-testid="command-row"
      data-command-id={record.command_id}
      data-status={record.status}
      data-code={record.code ?? ""}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-fog-200" title={record.summary}>
          {record.summary}
        </span>
        <span className={`shrink-0 font-medium ${STATUS_STYLE[record.status]}`}>
          {STATUS_LABEL[record.status]}
          {record.appliedTick !== undefined && record.status === "accepted"
            ? ` · tick ${record.appliedTick.toLocaleString("en-US")}`
            : ""}
        </span>
      </div>
      {record.status === "pending" && (
        <p className="mt-0.5 text-fog-500">Applies on the next tick (resume or step if paused).</p>
      )}
      {record.status === "rejected" && record.code && (
        <div className="mt-1 text-fog-200" data-testid="rejection-explanation">
          <p>
            <span className="metric text-signal-300">{record.code}</span>{" "}
            {REJECTION_EXPLANATION[record.code]}
          </p>
          {record.message && <p className="mt-0.5 text-fog-500">Engine: {record.message}</p>}
        </div>
      )}
    </li>
  );
}

/** The most recent operator commands, optionally only those of the given types. */
export function CommandFeedback({
  types,
  limit = 4,
}: {
  types?: readonly CommandRecord["type"][];
  limit?: number;
}) {
  const commands = useSimulation((s) => s.commands);
  const shown = commands.filter((c) => !types || types.includes(c.type)).slice(0, limit);
  if (shown.length === 0) return null;
  return (
    <ol className="mt-2 space-y-1" aria-live="polite" data-testid="command-feedback">
      {shown.map((c) => (
        <CommandResult key={c.command_id} record={c} />
      ))}
    </ol>
  );
}
