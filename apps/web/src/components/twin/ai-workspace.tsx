"use client";

import { fleetSnapshot, siteDemand } from "@warehouse-one/twin";
import { useEffect, useMemo } from "react";
import { formatSimClock, useSimulation } from "@/lib/sim/store";
import { useTwin } from "@/lib/twin/store";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/twin/view";
import { EvaluationControls, EvaluationResult } from "./evaluation";
import { Badge, Button, FailureNotice, Panel, Provenance } from "./parts";
import { ProposalReview } from "./review";

/**
 * AI mode (Phase 6): decision support for the line-haul fleet. Live context from the running
 * simulation, a deterministic optimiser and what-if comparisons run on frozen snapshots, proposals
 * reviewed and approved through the API, and optional AI explanations, each labelled by source.
 */
export function AiWorkspace() {
  const network = useSimulation((s) => s.config.network);
  const simulationId = useSimulation((s) => s.config.simulation_id);
  useEffect(() => {
    void useTwin.getState().loadCapabilities();
  }, []);
  useEffect(() => {
    void useTwin.getState().loadProposals();
  }, [simulationId]);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="ai-title" data-testid="ai-workspace">
      <header className="panel flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 id="ai-title" className="text-base font-semibold text-fog-50">
            Fleet decision support
          </h2>
          <p className="mt-0.5 max-w-3xl text-[11px] text-fog-400">
            Proposals for where idle line-haul trucks wait between jobs. A deterministic optimiser
            simulates the alternatives from the live state; you review, approve and apply them.
            Measured, simulated and AI-generated content is labelled as such.
          </p>
        </div>
        <ApiChips />
      </header>
      <WorkspaceFailure />
      {network ? <Workspace /> : <NoNetwork />}
    </section>
  );
}

function ApiChips() {
  const caps = useTwin((s) => s.capabilities);
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="twin-api-status">
      {caps.kind === "loading" && <Badge tone="muted">Checking the API…</Badge>}
      {caps.kind === "failed" && (
        <Badge tone="critical" testid="twin-api-offline">
          API unavailable · approvals disabled
        </Badge>
      )}
      {caps.kind === "ready" && (
        <>
          <Badge tone="ok" testid="twin-api-ready">
            Optimiser {caps.data.strategies.map((s) => `${s.id} v${s.version}`).join(", ")}
          </Badge>
          <Badge
            tone={caps.data.ai.configured ? "ok" : "muted"}
            testid="twin-ai-status"
            title={caps.data.ai.detail}
          >
            {caps.data.ai.configured ? `AI: ${caps.data.ai.model}` : "AI not configured"}
          </Badge>
        </>
      )}
    </div>
  );
}

function WorkspaceFailure() {
  const failed = useTwin((s) => s.failed);
  const busy = useTwin((s) => s.busy);
  if (!failed) return null;
  return (
    <FailureNotice
      failed={failed}
      busy={busy === failed.op}
      onDismiss={failed.op === "capabilities" ? undefined : () => useTwin.getState().dismiss()}
    />
  );
}

function NoNetwork() {
  return (
    <div className="panel p-5" role="status" data-testid="twin-no-network">
      <p className="text-sm font-semibold text-fog-50">This scenario has no line-haul fleet</p>
      <p className="mt-1 text-xs leading-5 text-fog-400">
        Fleet decision support plans where line-haul trucks wait between transfers, so it needs the
        logistics park. The single-site showcase has no network.
      </p>
      <div className="mt-3">
        <Button
          testid="twin-open-network"
          onClick={() => useSimulation.getState().loadScenario("network")}
        >
          Open the logistics park
        </Button>
      </div>
    </div>
  );
}

function Workspace() {
  const evaluation = useTwin((s) => s.evaluation);
  const proposal = useTwin((s) => s.proposal);
  const busy = useTwin((s) => s.busy);
  const result = evaluation.kind === "done" ? evaluation.result : null;
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <OperationalContext />
        <EvaluationControls />
        <ProposalList />
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {result ? (
          <>
            <EvaluationResult evaluation={result} />
            {proposal ? (
              <ProposalReview proposal={proposal} />
            ) : busy === "save" ? (
              <div
                className="panel p-4 text-xs text-fog-400"
                data-testid="twin-saving"
                aria-busy="true"
              >
                Saving the proposal: the API re-validates it…
              </div>
            ) : (
              <div className="panel p-4 text-xs text-fog-400" data-testid="twin-unsaved">
                Not saved as a proposal yet, so it cannot be approved. The comparison above is local
                to this browser.
              </div>
            )}
          </>
        ) : evaluation.kind === "running" ? (
          <div
            className="panel grid h-64 place-items-center text-xs text-fog-400"
            data-testid="twin-evaluating"
            aria-busy="true"
          >
            Simulating plans on a frozen snapshot… the live simulation keeps running.
          </div>
        ) : busy === "load" ? (
          <div className="panel h-64 animate-pulse bg-ink-850" aria-busy="true" />
        ) : (
          <div className="panel p-5" data-testid="twin-empty">
            <p className="text-sm font-semibold text-fog-50">No evaluation yet</p>
            <p className="mt-1 max-w-xl text-xs leading-5 text-fog-400">
              Run the optimisation to compare the standby plan in effect with candidate plans over
              the next simulated minutes, or compare a plan of your own. Earlier proposals for this
              run are listed on the left.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** What the operator is deciding about, measured from the live run (sampled every second). */
function OperationalContext() {
  const config = useSimulation((s) => s.config);
  const tick = useSimulation((s) => Math.floor(s.tick / 10) * 10);
  const paused = useSimulation((s) => s.paused);
  const state = useMemo(() => useSimulation.getState().state, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const fleet = fleetSnapshot(state);
  const demand = siteDemand(config, state).filter(
    (d) => d.transfers_per_hour > 0 || d.standby_capacity > 0,
  );
  const names = new Map(config.network?.sites.map((s) => [s.id, s.name]));
  return (
    <Panel
      title="Operational context"
      subtitle={`Simulated ${formatSimClock(config.epoch, tick * config.tick_ms)} · tick ${tick.toLocaleString("en-US")} · ${paused ? "paused" : "running"}`}
      aside={<Provenance kind="live" />}
      testid="twin-context"
    >
      <dl className="grid grid-cols-3 gap-2 text-[11px]" data-testid="twin-context-fleet">
        <div>
          <dt className="text-fog-400">Line-haul trucks</dt>
          <dd className="text-lg font-semibold text-fog-50">{fleet.trucks}</dd>
        </div>
        <div>
          <dt className="text-fog-400">Idle now</dt>
          <dd className="text-lg font-semibold text-fog-50">{fleet.idle}</dd>
        </div>
        <div>
          <dt className="text-fog-400">Waiting for a truck</dt>
          <dd className="text-lg font-semibold text-fog-50" data-testid="twin-waiting">
            {fleet.waiting_for_truck}
            <span className="text-[11px] font-normal text-fog-400">
              {" "}
              / {fleet.open_transfers} open
            </span>
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-fog-400" data-testid="twin-standby-now">
        Standby now:{" "}
        {Object.entries(fleet.standby)
          .map(([k, n]) => `${n} at ${k === "home" ? "the depot" : (names.get(k) ?? k)}`)
          .join(", ")}
      </p>
      <table className="mt-3 w-full text-left text-[11px]" data-testid="twin-demand">
        <caption className="mb-1 text-left text-fog-400">
          Demand model: transfers per hour each site sends, from the configured lanes
        </caption>
        <thead className="text-fog-400">
          <tr>
            <th scope="col" className="py-0.5 font-medium">
              Site
            </th>
            <th scope="col" className="py-0.5 text-right font-medium">
              Per hour
            </th>
            <th scope="col" className="py-0.5 text-right font-medium">
              Waiting
            </th>
            <th scope="col" className="py-0.5 text-right font-medium">
              Standby cap.
            </th>
          </tr>
        </thead>
        <tbody>
          {demand.map((d) => (
            <tr key={d.site_id} className="border-t border-white/5" data-testid="twin-demand-row">
              <th scope="row" className="py-0.5 font-normal text-fog-200">
                {d.site_name}
              </th>
              <td className="py-0.5 text-right text-fog-50 tabular-nums">{d.transfers_per_hour}</td>
              <td className="py-0.5 text-right text-fog-50 tabular-nums">{d.backlog}</td>
              <td className="py-0.5 text-right text-fog-50 tabular-nums">{d.standby_capacity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function ProposalList() {
  const proposals = useTwin((s) => s.proposals);
  const current = useTwin((s) => s.proposal?.proposal_id);
  return (
    <Panel
      title="Proposals for this run"
      subtitle="Newest first, stored by the API with their audit trail."
      testid="twin-proposals"
    >
      {proposals.kind === "loading" && <p className="text-[11px] text-fog-400">Loading…</p>}
      {proposals.kind === "failed" && (
        <p className="text-[11px] text-fog-400" data-testid="twin-proposals-unavailable">
          Unavailable while the API cannot be reached.
        </p>
      )}
      {proposals.kind === "ready" && proposals.data.length === 0 && (
        <p className="text-[11px] text-fog-400" data-testid="twin-proposals-empty">
          None yet for this run.
        </p>
      )}
      {proposals.kind === "ready" && proposals.data.length > 0 && (
        <ul className="space-y-1">
          {proposals.data.map((p) => (
            <li key={p.proposal_id}>
              <button
                type="button"
                onClick={() => void useTwin.getState().open(p.proposal_id)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-[11px] ${p.proposal_id === current ? "bg-white/10" : "hover:bg-white/5"}`}
                data-testid="twin-proposal-row"
                data-status={p.status}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-fog-200">
                    Tick {p.source_tick.toLocaleString("en-US")} ·{" "}
                    {p.kind === "what_if" ? "what-if" : "optimisation"}
                  </span>
                  <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                </span>
                <span className="mt-0.5 block truncate text-fog-400" title={p.headline}>
                  {p.objective.pct !== null ? `${p.objective.pct} % pickup wait · ` : ""}
                  {p.headline}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
