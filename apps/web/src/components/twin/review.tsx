"use client";

import { freshness, liveContext } from "@warehouse-one/twin";
import { useState } from "react";
import { useSimulation } from "@/lib/sim/store";
import type { ProposalDetail } from "@/lib/twin/api";
import { useTwin } from "@/lib/twin/store";
import { allowedActions, metricLabel, STATUS_LABEL, STATUS_TONE } from "@/lib/twin/view";
import { Badge, Button, Confirm, Panel, Provenance } from "./parts";

/** Review and approval of a stored proposal: server validation, decision, execution, audit. */
export function ProposalReview({ proposal }: { proposal: ProposalDetail }) {
  const busy = useTwin((s) => s.busy);
  const stale = useTwin((s) => s.stale);
  const conflict = useTwin((s) => s.conflict);
  const operator = useTwin((s) => s.operator);
  const [confirm, setConfirm] = useState<"approve" | "reject" | "execute" | null>(null);
  const [note, setNote] = useState("");
  const can = allowedActions(proposal.status);
  const named = operator.trim().length > 0;
  const changes =
    proposal.evaluation.candidates.find((c) => c.candidate_id === proposal.recommended_candidate_id)
      ?.changes.length ?? 0;
  const act = (what: "approve" | "reject" | "execute") => {
    setConfirm(null);
    const twin = useTwin.getState();
    void (what === "execute" ? twin.execute() : twin.decide(what, note));
  };
  return (
    <Panel
      title="Review and approval"
      subtitle={`Proposal ${proposal.proposal_id.slice(0, 8)} · created by ${proposal.created_by} · ${new Date(proposal.created_at).toLocaleString("en-GB")}`}
      aside={
        <Badge tone={STATUS_TONE[proposal.status]} testid="twin-status">
          <span data-status={proposal.status}>{STATUS_LABEL[proposal.status]}</span>
        </Badge>
      }
      testid="twin-proposal"
    >
      <Freshness proposal={proposal} />
      {stale && (
        <p
          className="mt-2 rounded-md border border-warn-400/40 bg-warn-400/10 p-2 text-xs text-warn-400"
          role="alert"
          data-testid="twin-stale"
        >
          Stale: {stale} The proposal is now expired. Run a new optimisation on the current state.
        </p>
      )}
      {conflict && (
        <p
          className="mt-2 rounded-md border border-warn-400/40 bg-warn-400/10 p-2 text-xs text-warn-400"
          role="alert"
          data-testid="twin-conflict"
        >
          {conflict}
        </p>
      )}
      <Validation proposal={proposal} />

      {(can.approve || can.reject || can.execute) && (
        <div className="mt-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-[11px] text-fog-400">
              Your name (recorded with the decision)
              <input
                value={operator}
                onChange={(e) => useTwin.getState().setOperator(e.target.value.slice(0, 80))}
                className="mt-1 block w-full rounded-md border border-white/10 bg-ink-850 px-2 py-1 text-xs text-fog-50"
                data-testid="twin-operator"
                autoComplete="name"
              />
            </label>
            <label className="text-[11px] text-fog-400">
              Note (optional)
              <input
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                className="mt-1 block w-full rounded-md border border-white/10 bg-ink-850 px-2 py-1 text-xs text-fog-50"
                data-testid="twin-note"
              />
            </label>
          </div>
          {confirm ? (
            <Confirm
              title={
                confirm === "approve"
                  ? "Approve this standby plan?"
                  : confirm === "reject"
                    ? "Reject this proposal?"
                    : "Apply the approved plan to the live simulation?"
              }
              confirmLabel={
                confirm === "approve" ? "Approve" : confirm === "reject" ? "Reject" : "Apply now"
              }
              variant={confirm === "reject" ? "danger" : "primary"}
              onConfirm={() => act(confirm)}
              onCancel={() => setConfirm(null)}
            >
              {confirm === "approve" &&
                `${changes} truck${changes === 1 ? "" : "s"} would get a new standby site. Approval checks first that the proposal still matches the live run; nothing changes in the simulation until you apply it.`}
              {confirm === "reject" && "The proposal is closed and can no longer be applied."}
              {confirm === "execute" &&
                `${proposal.commands.length} linehaul.set_standby commands go to the running simulation, which validates each one like any operator command. The proposal is executed once; it cannot be applied again.`}
            </Confirm>
          ) : (
            <div className="flex flex-wrap gap-2">
              {can.approve && (
                <Button
                  testid="twin-approve"
                  disabled={!named}
                  busy={busy === "decide"}
                  onClick={() => setConfirm("approve")}
                >
                  Approve
                </Button>
              )}
              {can.execute && (
                <Button
                  testid="twin-execute"
                  disabled={!named}
                  busy={busy === "execute" || busy === "report"}
                  onClick={() => setConfirm("execute")}
                >
                  {busy === "execute" ? "Applying…" : "Apply to live simulation"}
                </Button>
              )}
              {can.reject && (
                <Button
                  variant="danger"
                  testid="twin-reject"
                  disabled={!named}
                  busy={busy === "decide"}
                  onClick={() => setConfirm("reject")}
                >
                  Reject
                </Button>
              )}
              {!named && (
                <span className="self-center text-[11px] text-fog-400">
                  Enter your name to decide.
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <Outcome proposal={proposal} />
      <AiExplanation proposal={proposal} />
      <History proposal={proposal} />
    </Panel>
  );
}

/** Whether the proposal still describes the live run (shown here; the API decides). */
function Freshness({ proposal }: { proposal: ProposalDetail }) {
  const config = useSimulation((s) => s.config);
  const tick = useSimulation((s) => Math.floor(s.tick / 50) * 50);
  if (!["validated", "approved"].includes(proposal.status)) return null;
  const f = freshness(
    { ...proposal.evaluation.source, tick: proposal.source_tick },
    { ...liveContext(config, useSimulation.getState().state), tick },
    proposal.max_age_ticks,
  );
  return (
    <p
      className={`text-[11px] ${f.fresh ? "text-fog-400" : "text-warn-400"}`}
      data-testid="twin-freshness"
      data-fresh={f.fresh}
    >
      {f.fresh
        ? `Computed ${Math.round(f.age_ticks / 600)} simulated min ago from tick ${proposal.source_tick.toLocaleString("en-US")}; valid for ${proposal.max_age_ticks / 600} simulated minutes while the fleet's standby settings stay as they were.`
        : `${f.message} Approving or applying it will be refused.`}
    </p>
  );
}

function Validation({ proposal }: { proposal: ProposalDetail }) {
  return (
    <div className="mt-3" data-testid="twin-validation">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold text-fog-200">Server validation</p>
        <Provenance kind="server" />
      </div>
      <ul className="mt-1 grid gap-1 sm:grid-cols-2">
        {proposal.validation.map((v) => (
          <li
            key={v.id}
            className="flex gap-2 text-[11px]"
            data-testid="twin-validation-check"
            data-passed={v.passed}
          >
            <span className={v.passed ? "text-ok-400" : "text-critical-400"} aria-hidden>
              {v.passed ? "✓" : "✕"}
            </span>
            <span className="text-fog-200">
              {v.label}
              <span className="text-fog-400"> · {v.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Outcome({ proposal }: { proposal: ProposalDetail }) {
  const last = [...proposal.history]
    .reverse()
    .find((h) => h.action === "applied" || h.action === "failed");
  if (!last) return null;
  const results = (last.details.results ?? []) as {
    command_id: string;
    accepted: boolean;
    code?: string;
    message?: string;
  }[];
  const ok = proposal.status === "applied";
  return (
    <div
      className={`mt-3 rounded-md border p-2 text-xs ${ok ? "border-ok-400/30 bg-ok-400/10 text-ok-400" : "border-critical-400/40 bg-critical-400/10 text-critical-400"}`}
      data-testid="twin-outcome"
      data-outcome={proposal.status}
    >
      {ok
        ? `Applied at tick ${proposal.executed_tick?.toLocaleString("en-US") ?? "?"}: the engine accepted all ${results.length} commands. Idle trucks move to their new standby sites as they finish their current work.`
        : `Not applied: ${
            results
              .filter((r) => !r.accepted)
              .map((r) => `${r.command_id} ${r.code ?? ""} ${r.message ?? ""}`.trim())
              .join("; ") ||
            last.note ||
            "no engine result"
          }.`}
    </div>
  );
}

function AiExplanation({ proposal }: { proposal: ProposalDetail }) {
  const caps = useTwin((s) => s.capabilities);
  const busy = useTwin((s) => s.busy);
  const ai = caps.kind === "ready" ? caps.data.ai : null;
  const latest = [...proposal.explanations].reverse().find((e) => e.status === "ok");
  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-ink-850/60 p-3" data-testid="twin-ai">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-fog-50">AI explanation</p>
          <Provenance kind="ai" />
        </div>
        {ai?.configured && (
          <Button
            variant="secondary"
            testid="twin-ai-explain"
            busy={busy === "explain"}
            onClick={() => void useTwin.getState().explain()}
          >
            {busy === "explain" ? "Asking…" : latest ? "Explain again" : "Explain with AI"}
          </Button>
        )}
      </div>
      {ai && !ai.configured && (
        <p className="mt-1 text-[11px] text-fog-400" data-testid="twin-ai-unavailable">
          AI unavailable: {ai.detail} Everything above is computed without it.
        </p>
      )}
      {!ai && (
        <p className="mt-1 text-[11px] text-fog-400">
          AI status unknown: the API is not reachable.
        </p>
      )}
      {latest?.content && (
        <div className="mt-2 text-xs text-fog-200" data-testid="twin-ai-explanation">
          <p className="font-semibold text-fog-50">{latest.content.headline}</p>
          <p className="mt-1 leading-5">{latest.content.explanation}</p>
          {[
            ["Trade-offs", latest.content.trade_offs],
            ["Risks", latest.content.risks],
            ["Check before approving", latest.content.operator_checks],
          ].map(([title, items]) =>
            (items as string[]).length ? (
              <div key={title as string} className="mt-2">
                <p className="text-[11px] font-semibold text-fog-200">{title as string}</p>
                <ul className="list-disc pl-4 text-[11px] text-fog-400">
                  {(items as string[]).map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          {latest.content.cited_metrics.length > 0 && (
            <p className="mt-2 text-[11px] text-fog-400">
              Cited (checked against the proposal):{" "}
              {latest.content.cited_metrics
                .map((m) => `${metricLabel(m.metric)} ${m.baseline ?? "—"} → ${m.candidate ?? "—"}`)
                .join("; ")}
            </p>
          )}
          <p className="mt-1 text-[10px] text-fog-500">
            {latest.model} · {latest.prompt_version} · {latest.latency_ms} ms · stance{" "}
            {latest.content.stance.replace("_", " ")}
          </p>
        </div>
      )}
    </div>
  );
}

function History({ proposal }: { proposal: ProposalDetail }) {
  return (
    <details className="mt-3" data-testid="twin-history" open>
      <summary className="cursor-pointer text-[11px] font-semibold text-fog-200">
        Audit trail ({proposal.history.length})
      </summary>
      <ol className="mt-1 space-y-1 border-l border-white/10 pl-3 text-[11px]">
        {proposal.history.map((h, i) => (
          <li key={`${h.recorded_at}-${i}`} data-testid="twin-history-entry" data-action={h.action}>
            <span className="text-fog-50">{h.action}</span>
            <span className="text-fog-400">
              {" "}
              · {h.from_status ? `${h.from_status} → ` : ""}
              {h.to_status} · {h.actor} · {new Date(h.recorded_at).toLocaleTimeString("en-GB")}
            </span>
            {h.note && <span className="text-fog-200"> · “{h.note}”</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}
