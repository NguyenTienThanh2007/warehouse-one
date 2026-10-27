# Phase 6 — AI logistics brain and digital twin (first vertical slice)

**Branch:** `feature/p6-ai-digital-twin` · **Base:** `main` @ `b2ccfdc` (PR #10 merged; Phases 0–5
merged)
**Status:** IN REVIEW (pull request to `main`; not merged).

## 1. Starting point (verified 2026-10-27)

| Check | Result |
|-------|--------|
| `main` | `b2ccfdc` = `origin/main`: PR #9 (Phase 4 analytics, `5490c54`) and PR #10 (local API connection fix) merged |
| Working tree | Clean before branching |
| Modes | Explore, Operate, Analytics available; Build and AI planned |
| AI | None in the code; `.env.example` listed provider keys only |
| Network engine | Transfers are assigned to the nearest idle truck the tick they are planned; idle trucks drive home to the depot |

Measured before designing (network scenario, 1 h from tick 6,000): transfers waited 21–56 s for a
truck to be assigned plus 21–58 s for it to arrive, and trucks drove 47 km empty to pickups for
49 km loaded. That is where this slice works.

## 2. What was built

One decision, end to end: **where idle line-haul trucks wait between jobs** (fleet standby).

```text
live run (browser) ──snapshot──► @warehouse-one/twin: optimiser + what-if (engine step(), frozen input)
                                   │ evaluation (baseline, candidates, deltas, constraints, provenance)
                                   ▼
                     POST /api/v1/twin/proposals ──► server validation ──► twin.proposals (+ snapshot)
                                   │                                      twin.proposal_events (append-only)
     operator: review → approve (freshness check) → apply (claim once) → engine commands → report
                                   │
                     optional: POST …/explanations ──► AI provider (structured, policy-checked)
```

### 2.1 Engine: one new operator command

`linehaul.set_standby {vehicle_id, site_id|null}` (contracts, JSON Schema, Pydantic mirror). An idle
truck with a standby site parks on a staging stall there instead of driving home, taking a stall
only while another stays free for arriving trucks; `null` sends it home. Rejections:
`UNKNOWN_VEHICLE`, `UNKNOWN_SITE`, `INVALID_STANDBY` (depot, gateway, or more than "staging stalls
− 1" trucks at a site), `NETWORK_DISABLED`. A new invariant checks standby sites and counts. No new
event type; trucks without standby keep the original state shape, so every golden fixture is
byte-identical (DEC-039).

### 2.2 Digital twin (`packages/twin`)

- **Input:** a `Snapshot` of the live run (config, state, hash). Checked before use: hash, engine
  invariants, a network with a fleet.
- **What-if:** `simulate()` runs `step()` forward for the horizon from the frozen state, applying a
  plan through the same `linehaul.set_standby` commands an approval would submit, and measures the
  fleet from the engine's own events. Because `step()` never mutates its input, any number of
  trajectories run from one snapshot, one after another or concurrently, and the live run is never
  touched (tested with a running runner).
- **Optimiser `fleet-standby` v1.0.0:** demand per site from the configured lanes; candidates
  are demand-proportional allocations (D'Hondt, capped by standby capacity) for several fleet
  shares plus the busiest origin filled; then first-improvement local search (single-truck moves)
  until the budget (default 8 simulations, baseline included) is spent. A heuristic over a bounded
  budget: the recommendation is the best plan evaluated, never claimed optimal.
- **Objective and constraints:** minimise mean pickup wait (planned → loading starts; waits open at
  the end count until the end). Hard constraints: fleet coverage, eligible sites, stall capacity
  (plan stage); engine accepts every command, invariants hold all horizon, at least 95 % of the
  baseline's pallets delivered, no more cancellations (simulation stage). A plan that breaks a
  plan-stage rule is reported infeasible and not simulated.
- **Recommendation threshold:** at least 5 % and 2 s better than the baseline, so single-trajectory
  noise is not sold as an improvement. Otherwise the result says why nothing is recommended.
- **Determinism:** identical snapshot, options and strategy version give an identical evaluation,
  including its id (a hash of the inputs).
- **Metrics** (`METRICS`, units in the names): `pickup_wait_s`, `pickup_wait_p90_s`, `empty_km`,
  `loaded_km`, `transfers_planned`, `pallets_planned`, `transfers_delivered`, `pallets_delivered`,
  `transfers_cancelled`, `transfers_waiting_end`, `lead_time_s`. Deltas: absolute, and percentage
  only when the baseline is non-zero (otherwise `null`, shown "n/a").

### 2.3 API (`/api/v1/twin`, migration `0004_twin`)

| Endpoint | Purpose |
|----------|---------|
| `GET /capabilities` | Strategies, AI status (never the key), execution path, lifecycle, limits |
| `POST /proposals` | Store an evaluation + snapshot; server re-validates → `validated`, `not_actionable` or `invalid`. Same evaluation again → 200 with the stored proposal |
| `GET /proposals?limit&cursor&status&simulation_id` | Newest first, at most 50 per page, keyset cursor |
| `GET /proposals/{id}` | Evaluation (server-computed deltas), validation, commands, audit history, explanations |
| `GET /proposals/{id}/snapshot` | The input snapshot, to re-run the evaluation |
| `POST /proposals/{id}/decision` | `approve` (needs the live context; stale → `expired`, 409 `STALE_PROPOSAL`) or `reject`; repeats are idempotent, contradictions 409 |
| `POST /proposals/{id}/execution` | Claim an approved, fresh proposal once (`executing`), returns the commands |
| `POST /proposals/{id}/execution/result` | `applied` only with every issued command accepted; else `failed` |
| `POST /proposals/{id}/explanations` | AI explanation (503 `AI_NOT_CONFIGURED` without a provider) |

Server validation of a new proposal: strategy supported; the snapshot is the evaluated state (hash,
run, tick); the baseline is the plan in effect in the snapshot; the recommended candidate exists,
is feasible and met every constraint; the plan meets the standby rules (re-checked from the
snapshot's network config); the objective improvement and the service level hold (recomputed from
the metrics); the derived commands match the command contract. Deltas are recomputed with the same
rounding as TypeScript and stored. Errors use the envelope `{"error": {code, message, details}}`.

### 2.4 AI explanations (optional, server-side)

`WAREHOUSE_AI_PROVIDER=anthropic` + `WAREHOUSE_AI_API_KEY` (+ optional `WAREHOUSE_AI_MODEL`,
default `claude-opus-5-5`, `WAREHOUSE_AI_EFFORT`, `WAREHOUSE_AI_TIMEOUT_S`). The official
`anthropic` SDK sends a fact sheet of the stored proposal with structured outputs
(`output_config.format` JSON schema) and server-side refusal fallbacks. The answer is validated
(Pydantic, length limits) and policy-checked: cited figures must equal stored figures; no support
for approving a proposal the server did not validate. Failures (`AI_TIMEOUT`, `AI_RATE_LIMITED`,
`AI_UNAVAILABLE`, `AI_AUTH_FAILED`, `AI_REFUSED`, `AI_INVALID_OUTPUT`, `AI_POLICY_VIOLATION`) are
stored and answered with stable codes; at most 5 attempts per proposal. Logs carry provider, code
and duration only. Without a provider everything else works and the workspace says so (DEC-041).

### 2.5 AI mode (web)

The AI tab is now available. The workspace covers the 3D view (which stops rendering, like
Analytics) while the live simulation keeps running underneath:

- **Operational context** (labelled *Live · measured*): simulated clock, fleet status, transfers
  waiting, standby now, demand model per site.
- **Optimise / what-if:** horizon 15/30/60 simulated minutes, progress, cancel; an editor for the
  operator's own plan (trucks per site), compared with the plan in effect.
- **Results** (labelled *Simulated prediction · deterministic optimiser*): recommendation with
  reasons, plan in effect vs proposed, hard constraints, objective bars for every plan, baseline vs
  candidate table with absolute and percentage changes, assumptions, risks and input identities.
- **Review** (*Checked by the API*): status, freshness, server validation, approve/reject with a
  confirmation and the operator's name and note, apply to the live simulation with confirmation,
  outcome, audit trail.
- **AI explanation** (*AI-generated · not a measurement*): only when configured; otherwise the
  reason is shown.
- **States:** API unreachable/blocked/wrong version (shared diagnosis with Analytics), AI
  unavailable, no network (single-site scenario), no recommendation, infeasible plan, stale
  proposal, conflicting decision, evaluation in progress. Retry repeats exactly the operation that
  failed (e.g. saving a computed evaluation, not re-running it).

## 3. How to run

```bash
pnpm install && (cd apps/api && uv sync --all-extras)
docker compose up -d --build --wait        # API with migration 0004
pnpm dev                                   # then the AI tab, or /?mode=ai
pnpm bench:twin                            # optimiser benchmark (fixed start points)
pnpm twin:verify --api http://localhost:8000 --proposal <uuid>   # re-run a stored proposal
```

AI explanations: set `WAREHOUSE_AI_PROVIDER=anthropic` and `WAREHOUSE_AI_API_KEY` for the API
(never `NEXT_PUBLIC_*`), then recreate it.

## 4. Verification (Apple M2, macOS, 2026-10-27)

| Check | Command | Result |
|-------|---------|--------|
| Format, lint, typecheck, unit tests, build | `pnpm check` | PASS: contracts 26, simulation 160 (6 new standby tests), recorder 10, twin 19, web 105; build OK |
| Golden fixtures | foundation-demo, operations-demo, network-demo | Byte-identical; new `twin-standby` fixture reproduced exactly by `fixture.test.ts` |
| Python lint / types | `uv run ruff check . && uv run ruff format --check . && uv run mypy` (+ Airflow DAG lint) | PASS |
| Python unit tests | `uv run pytest` | PASS: 117 (rules 25, AI 21 new) |
| Python integration (PostgreSQL, throwaway container) | `uv run pytest -m "integration and not kafka"` | PASS: 66 (twin lifecycle 20 new), incl. migration up/down/up |
| Migration drift | `uv run alembic check` | No new upgrade operations |
| Python Kafka/S3 tests | `uv run pytest -m kafka` | NOT RUN locally: pipeline code unchanged; CI data-platform job runs them |
| Browser E2E, real GPU | `pnpm test:e2e` | PASS: 53 passed, 3 skipped (live specs need an API URL) |
| Browser E2E, CI mode (SwiftShader) | `CI=1 pnpm test:e2e ai.spec navigation.spec` | PASS: 13 |
| AI mode against a real API (from source, throwaway DB) | `TWIN_API_URL=… pnpm test:e2e ai-live` | PASS: 1 (server validation, approval, apply, audit, second execution refused) |
| API image | `docker build --target api` (separate tag), migrate, `/health/ready`, `/api/v1/twin/capabilities` | PASS (`anthropic` 1.17.0 installed) |
| Reproducibility | `pnpm twin:verify` on a stored proposal / a tampered copy | `ok: true` / mismatches `c1.metrics`, `c1.deltas` |
| Live AI provider | real Anthropic call | NOT RUN: no key; providers are tested with fakes only |

Optimiser benchmark (`pnpm bench:twin`, horizon 30 simulated minutes, budget 8 simulations):

| Start tick | Baseline mean pickup wait | Recommended | Change | Empty km | Wall time |
|------------|---------------------------|-------------|--------|----------|-----------|
| 6,000 | 80.5 s | 2 terminal, 3 cross-dock, 1 depot | 58.0 s (−28 %) | 16.2 → 14.6 | 12.8 s |
| 20,000 | 86.0 s | 1 DC, 2 terminal, 3 cross-dock | 74.6 s (−13.3 %) | 15.7 → 15.5 | 15.8 s |

At tick 20,000 the busiest-origin plan (3 trucks at the terminal) is worse than the baseline
(90.8 s) and is reported as "no better"; the no-improvement path is also covered by tests (no
transfers in the horizon; a plan equal to the one in effect).

Seen in the browser (production build, real API from source): the optimisation ran while the live
run kept advancing, the API validated the proposal (8/8 checks), approval and application went
through, and the live state carried exactly the approved plan.

## 5. Limitations (honest)

- **Client-side computation.** Evaluations run in the browser's main thread (in 400-tick slices, so
  the page and the live run keep going). A module worker was tried: Next 16.3's Turbopack copies
  `new Worker(new URL(...))` targets as raw files instead of bundling them. Isolation does not
  depend on a thread (frozen input, pure engine).
- **The server trusts the computed metrics** it is given, as it trusts recorded runs: it checks
  their consistency and the plan's rules but does not re-simulate. `pnpm twin:verify` re-runs any
  stored proposal and fails on any differing figure.
- **One trajectory per plan.** Lanes draw quantities at random as stock changes, so plans can see
  slightly different workloads; the threshold and the workload metrics make that visible, but
  there is no multi-seed confidence interval yet.
- **Heuristic search.** At most 12 simulations; no proof of optimality. Standby is per truck, and
  which truck goes where matters (labels name the trucks).
- **Freshness is reported by the browser** (run, tick, fleet fingerprint); actors are names, not
  authenticated users (Phase 7).
- **Execution outcome** is reported by the browser after the engine applied the commands; if that
  report cannot reach the API the proposal stays `executing` until it is retried.
- **One AI provider** (Anthropic). The provider interface takes others; none is implemented.

## 6. Next increments

1. A worker-based evaluator (or a Node evaluation service) to free the main thread.
2. Multi-seed evaluation with confidence intervals; longer horizons in the background.
3. More strategies on the same pipeline: transfer consolidation, depot-return policy, service
   scheduling; DC slotting.
4. Feed applied proposals back into Analytics (before/after on recorded runs).
5. Authentication and roles for approval (Phase 7).
