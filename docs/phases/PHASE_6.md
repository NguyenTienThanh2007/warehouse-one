# Phase 6 — AI logistics brain and digital twin (first vertical slice)

**Branch:** `feature/p6-ai-digital-twin` · **Base:** `main` @ `b2ccfdc` (PR #10 merged; Phases 0–5
merged)
**Status:** MERGED into `main` as `72a2a0f` (PR #11, 2026-10-27; `main` CI run 40541684889: 5/5
jobs green). Phase 6.1 (§7, evaluation off the main thread) is MERGED as `dd1d1a7` (PR #12,
2026-11-01; `main` CI run 41304258402: 5/5 jobs green). Phase 6.2 (§8, multi-seed robustness
validation) is MERGED as `61c67d5` (PR #13, 2026-11-01; `main` CI run 41322552933: 5/5 jobs
green). Its statistical corrections are MERGED: the verdict correction (§8.9) as `2117d38`
(PR #14, 2026-11-02; `main` CI run 41453506465: 5/5 jobs green) and the confidence-interval display
precision (§8.10) as `6b1794b` (PR #15, 2026-11-02; `main` CI run 41460371089: 5/5 jobs green).
Phase 6.2 is complete; Phase 7 has not started.

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

- **Client-side computation** (as merged). Evaluations ran in the browser's main thread (in 400-tick
  slices). A module worker was tried: Next 16.3's Turbopack copies `new Worker(new URL(...))`
  targets as raw files instead of bundling them. Isolation did not depend on a thread (frozen
  input, pure engine). Addressed by Phase 6.1 (§7).
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

1. ~~A worker-based evaluator to free the main thread~~: Phase 6.1 (§7).
2. Multi-seed evaluation with confidence intervals; longer horizons in the background.
3. More strategies on the same pipeline: transfer consolidation, depot-return policy, service
   scheduling; DC slotting.
4. Feed applied proposals back into Analytics (before/after on recorded runs).
5. Authentication and roles for approval (Phase 7).

## 7. Phase 6.1 — evaluation off the main thread

**Branch:** `feature/p6-1-evaluation-worker` · **Base:** `main` @ `72a2a0f` (PR #11 merged)
**Status:** MERGED as `dd1d1a7` (PR #12, 2026-11-01). Decision: DEC-042.

### 7.1 Problem

A 30-minute optimisation took about 12 s on the page's main thread and produced long tasks (up to
~100 ms): the page and the live simulation competed with the optimiser for one thread.

### 7.2 Architecture

```text
live run ──frozen Snapshot──► optimiser (main thread: decisions and bookkeeping only)
                                  │ batches of trajectory jobs (TrajectoryExecutor)
                                  ▼
                   WorkerPool (min(4, cores − 1) module workers, public/workers/twin-evaluation.js)
                     start ─► progress* ─► completed | cancelled | failed   (per job, zod-validated)
                                  │
                         results in job order ─► the same Evaluation as before ─► API validation
```

- **Executor seam** (`packages/twin/src/executor.ts`): the optimiser decides what to simulate and
  hands batches to a `TrajectoryExecutor`; `inlineExecutor` runs them one after another,
  `WorkerPool` in parallel. Phase 1 runs the baseline and all initial candidates together; local
  search simulates neighbours in windows of up to the pool size and then takes them in order,
  exactly as a one-by-one search would (results after the first improvement are discarded unused).
  The evaluation, its id included, is identical at any pool size (golden fixture, tests).
- **Worker bundle:** Turbopack does not bundle module workers (re-checked: the client chunk points
  at the raw `.ts`), so `scripts/build-twin-worker.mjs` bundles `evaluation.worker.ts` with esbuild
  (in the lockfile already) before `next dev` and `next build`: 522 KiB minified, 114 KiB gzipped,
  about 80–170 ms to build.
- **Protocol** (`worker-protocol.ts`): `start` / `cancel` to the worker; `ready`, `progress`,
  `completed`, `cancelled`, `failed` back; every job message carries a request id and a job id;
  both directions are validated with zod. The worker checks the snapshot's hash and the engine
  invariants before simulating (once per snapshot), never mutates it, and reports progress every
  1,000 ticks.
- **Limits:** 2 concurrent requests; 16 jobs per request; horizon ≤ 36,000 ticks; 64 commands per
  job; a job silent for 30 s is stopped and its worker replaced; a new worker must be ready within
  15 s; a cancelled job must stop within 2 s or its worker is terminated; idle workers are
  terminated after 60 s. Workers are reused across requests, never one per candidate.
- **Failure handling:** worker cannot load → `WORKER_UNAVAILABLE` (every waiting request fails; no
  respawn loop); crash → `WORKER_CRASHED` (only that request fails; a replacement serves the next);
  stall → `WORKER_TIMEOUT`; too much → `RESOURCE_LIMIT`; bad input → `INVALID_REQUEST` /
  `INVALID_SNAPSHOT`; the twin's own `CANCELLED`, `EVALUATION_TIMEOUT` (120 s), `INVALID_OPTIONS`.
  For worker failures the workspace offers "Run on the main thread instead" explicitly; results
  computed that way are labelled *Main thread (fallback)*. `?twinExecution=main-thread` forces it
  (benchmarks, diagnosis).
- **Cancellation:** Cancel (or leaving AI mode) aborts the request: queued jobs never start,
  running ones are told to stop, the promise rejects at once, the workspace shows a deterministic
  *Evaluation cancelled* state, and no late message can update it (request ids; the store ignores
  any request but the current one). Cancelling one request never touches another request's jobs
  on the shared pool; a cancelled worker is freed only by its own job's final message; a worker
  refuses a second job under a request id it is already running.
- **Workspace:** stage (validating, simulating, local search, ranking), simulations done and
  running, elapsed time, execution mode; results show where and how long they were computed.
  Workers report progress about 25 times a second; the store publishes it at most every 250 ms
  (a new stage at once), only the progress bar subscribes to it, and the bar is scaled with a
  transform rather than resized (§7.3.2).
  Approval and execution are unchanged; the API still re-validates every proposal.

### 7.3 Benchmarks (Apple M2 × 8, 8 GiB, macOS 26, headless Chromium 153, 2026-11-01)

#### 7.3.1 Evaluation time, blocking, frames, memory, throughput

`pnpm bench:twin-browser -- --runs 3`: production build, AI mode on the logistics park, optimiser
budget 8 (8 simulations), live simulation at 1×, API stubbed; every configuration in a fresh page
and browser context; median of 3 runs; machine kept awake (`caffeinate`). Late frames are frames
more than 20 ms after the previous one (a missed vsync); "steady" excludes the first second and the
last half second of the run.

| Horizon | Mode | Wall time | Throughput (simulated ticks/s) | Long tasks (total) | Longest task | Mean FPS | Frame p95 / max | Late frames, steady | Live run |
|---------|------|-----------|--------------------------------|--------------------|--------------|----------|-----------------|---------------------|----------|
| 15 min | workers ×4 | **2.7 s** | 26,866 | 0 | — | 56.5 | 33 / 50 ms | 2.2 % | 9.9 ticks/s |
| 15 min | main thread | 5.8 s | 12,384 | 0 | — | 42.9 | 33 / 67 ms | 32.4 % | 9.9 ticks/s |
| 30 min | workers ×4 | **5.1 s** | 28,397 | 0 | — | 57.9 | 17 / 33 ms | 1.6 % | 10.0 ticks/s |
| 30 min | main thread | 12.3 s | 11,745 | 4 (228 ms) | 70 ms | 42.6 | 33 / 67 ms | 36.7 % | 10.0 ticks/s |
| 60 min | workers ×4 | **11.5 s** | 25,063 | 0 | — | 58.0 | 17 / 33 ms | 2.1 % | 10.0 ticks/s |
| 60 min | main thread | 27.5 s | 10,473 | 34 (1,952 ms) | 103 ms | 39.7 | 50 / 117 ms | 42.7 % | 10.0 ticks/s |

- **2.2–2.4× faster**, with **no main-thread long task** at any horizon (the main thread has up to
  34 per evaluation). The live run keeps its 10 ticks/s in both modes.
- **Start and end of a run:** in the first second 0–2 frames are late with workers (15–19 on the
  main thread). In the last half second, ranking and rendering the result make 5–8 frames late in
  *both* modes; that is why the short 15-minute run still shows a 33 ms p95.
- **Memory:** resident memory of the renderer process (page and workers, read with `ps`) peaks at
  443–472 MB with workers against 364–395 MB on the main thread: the workers cost roughly
  50–110 MB while they run (each holds the engine and its copy of the snapshot) and are terminated
  after 60 s idle. Page JS heap after a run: 19.6 MB in both modes. The machine had 8 GiB with the
  data stack running in Docker; absolute RSS figures vary between runs by tens of MB.
- **Worker start-up** (fetch, compile, engine load to `ready`): 65 ms cold, 46 ms warm.
- **Throughput against pool size** (30 min, `navigator.hardwareConcurrency` overridden):

  | Workers | Wall time | Simulated ticks/s |
  |---------|-----------|-------------------|
  | 1 | 11.0 s | 13,110 |
  | 2 | 5.9 s | 24,271 |
  | 4 | 5.4 s | 26,617 |

  One worker matches the main thread (no throughput lost to messaging); two nearly double it; four
  add little at budget 8. Likely reasons, not separately measured: the search has few
  simulations to run at once (the first batch, then local-search windows), and the M2 has four
  performance cores shared with the page and the browser.

**Node, inline reference** (`pnpm bench:twin -- --components`, one thread, 2026-10-31):

| Measurement | Result |
|-------------|--------|
| Snapshot preparation (`createSnapshot` + `checkSnapshot`) | 3.5 ms median |
| One trajectory: 9,000 / 18,000 / 36,000 ticks | 0.81 s / 1.51 s / 3.58 s (84–99 µs/tick) |
| Full evaluation, 30 min, budget 8 (start tick 6,000 / 20,000) | 13.9 s / 15.6 s, same recommendations as Phase 6 (−28 % / −13.3 %) |
| Full evaluation, 60 min, budget 8 | 30.9 s |
| Full evaluation, 30 min, maximum budget 12 | 19.3 s |

Not measured: a larger fleet. `createNetworkScenario` has a fixed fleet of 6 trucks and no existing
configuration offers more.

#### 7.3.2 Why frames were still slowed to ~30 Hz, and what changed

The first benchmark of this branch reported a 33 ms frame p95 with workers. That is a statistic
on the edge of one missed vsync (16.7 → 33.3 ms), not a 30 FPS frame rate: mean FPS in the same
situation was 56–58.
`pnpm bench:twin-frames` attributes it by switching suspects on and off in 8-second windows of a
running 60-minute evaluation (2–3 runs each; ranges):

| Variation | Late frames | Layout (ms/s) | DOM mutations/s | Main-thread busy (ms/s) |
|-----------|-------------|---------------|-----------------|-------------------------|
| No evaluation, live run on | 1.1–1.9 % | 1 | 2 | 73–81 |
| No evaluation, live run paused | 0 % | 0 | 0 | 31 |
| 4 or 7 busy-loop workers that send nothing | 0–0.4 % | 0 | 2 | 31–39 |
| Evaluation on workers, **before** | 3.4–5.5 % | 9.5 | 271 | 86 |
| Evaluation on workers, live run paused, **before** | 4.8–7.6 % | 8.5 | 260 | 59 |
| Evaluation on workers, **after** | 3.4–5.0 % | 1 | 15 | 56 |
| Evaluation on workers, live run paused, **after** | 2.3–3.7 % | 1 | 15 | 24 |
| … after, only 1 progress message in 4 delivered | 2.4–3.5 % | 1 | 13 | 51 |
| … after, no progress message delivered | 1.1–2.8 % | 1 | 3 | 48 |
| Evaluation on the main thread, before / after | 24–27 % / 21–25 % | 3 / 1 | 248 / 12 | 917 / 903 |

- **Not CPU contention:** busy workers on every spare core leave the page at 60 FPS.
- **Not rendering:** the 3D view does not draw in AI mode (`frameloop="never"`).
- **Not serialisation:** a job's start message (about 93 KB as JSON) takes about 0.25 ms to post.
- **Cause:** every progress message (about 25 a second from four workers) re-rendered the whole
  AI workspace, and the progress bar animated its `width`, so layout ran on most frames.
  **Fix:** the store publishes progress at most every 250 ms (stage changes at once), only the
  progress bar subscribes to it, and the bar animates a transform. DOM mutations fell from 271 to
  15 a second, layout from 9.5 to 1 ms/s, main-thread time from 86 to 56 ms/s; the live region now
  announces stage changes only.
- **Not fully solved:** with the live run on, 3.4–5 % of frames in these windows still miss one
  vsync (idle: 1.1–1.9 %; in these windows every late frame missed exactly one vsync, max
  33.5 ms, and there was no long task). Delivering a quarter or none of the
  progress messages moves this within run-to-run spread, so a worker-side throttle was not added.
  In the full benchmark (§7.3.1) steady-state late frames are 1.6–2.2 %, and frame p95 is 16.8 ms
  for 30- and 60-minute runs.
- Headless Chromium renders with SwiftShader and its frame timing is coarse; a single machine and
  browser were measured.

### 7.4 Verification

| Check | Result |
|-------|--------|
| Parity with the original Phase 6 evaluator (`main` @ `72a2a0f`): 3 seeds × start ticks 3,000 / 12,000 / 24,000; horizons 15 and 30 min with budgets 6 and 12; inline and 4-way parallel with jobs finishing in reverse order; what-if comparisons | 45 of 45 evaluations byte-identical (runtime field excluded), ids included |
| Executor parity (`executor.test.ts`): parallelism 1, 2, 3, 4, 8, jobs finishing in reverse order | Byte-identical to the golden evaluation |
| Worker core with the real engine; pool with fake workers (`worker-pool.test.ts`, 17 tests) | Identical trajectories and evaluations; concurrency and limits; cancelling one request leaves the other untouched (running or queued); duplicate request ids refused; cancel; crash, stall, unreadable and rogue messages, load failure; worker replacement; late messages; idle shutdown; frozen input untouched |
| Workspace store (`store.test.ts`, 2 tests) | A new stage is shown at once; progress within a stage coalesced to one update per 250 ms (20 messages → 1 update); no superseded or late update after a newer stage or after the result |
| Browser (`ai.spec.ts`, Phase 6.1 block, 5 tests) | Progress and mode; cancel with no late result; page interactive and live run at 10 ticks/s during evaluation; leaving AI mode stops it; worker vs main thread identical on one paused snapshot; worker missing → explicit fallback; worker crash → `WORKER_CRASHED` |
| Phase 6 browser flows | Unchanged and passing, now through the worker pool |

Full results of every check are in the pull request.

### 7.5 Limitations

- With the live run on, 2–5 % of frames still miss one vsync while an evaluation runs (§7.3.2),
  and finishing an evaluation (ranking, rendering the result) costs 5–8 late frames in both modes.
- Four workers are only slightly faster than two at the default budget; the pool is not sized to
  the search's parallelism.
- The optimiser's bookkeeping, snapshot creation (3.5 ms) and result assembly stay on the main
  thread; they are short.
- A worker that cannot be loaded makes the operator choose the main thread; there is no automatic
  fallback by design.
- `pnpm dev` builds the worker once at start: restart it after changing `packages/twin` or
  `packages/simulation`.
- Benchmarks are headless on one machine (Apple M2, 8 GiB); a sleep during a run invalidates it
  (keep the machine awake).

## 8. Phase 6.2 — multi-seed robustness validation

**Branch:** `feature/p6-2-multi-seed-evaluation` · **Base:** `main` @ `dd1d1a7` (PR #12 merged)
**Status:** MERGED as `61c67d5` (PR #13, 2026-11-01). Decision: DEC-043. Post-merge
correction: §8.9.

### 8.1 Problem

The optimiser simulates every plan on one future: the live run's own random stream, frozen in the
snapshot. It recommends the best plan on that future, so the reported gain is the gain of a plan
*selected* on it: part of it may be luck, and nothing showed how much. Phase 6.2 re-runs one
recommended plan and the plan in effect on many other futures of the same present and reports,
with stated uncertainty, whether the gain holds and whether every hard constraint still holds.

### 8.2 Architecture

```text
discovery: optimizeStandby(snapshot)            one future (the snapshot's own stream)
   │ candidate cN (its plan and the optimiser's commands)
   ▼
evaluateRobustness(snapshot, discovery, cN, {seeds, root_seed})      packages/twin/src/robustness.ts
   │ seed i = 1…n: state with rng = seedRng("twin-robustness:<root>:<i>")  (hash recomputed)
   │ per seed two jobs from that identical start: baseline (no commands) and candidate
   │ batches of 8 seeds = 16 jobs, each job carrying its own start (TrajectoryJob.start)
   ▼
TrajectoryExecutor: WorkerPool (Phase 6.1 workers, start hash re-verified) | inline (main thread)
   ▼
per seed: metrics, deltas, hard constraints, demand divergence ──► stats.ts (paired t) ──► verdict
   ▼
AI workspace: "Robustness across futures" panel — advisory, not sent to the API
```

- **Seeds** (`seededStarts`): seed i is `seedRng("twin-robustness:<root>:<i>")`, the engine's own
  seeding; `root` defaults to the first 12 characters of the snapshot hash and may be set
  (`[A-Za-z0-9_-]{1,40}`). Only `state.rng` changes: no engine invariant involves it, every other
  branch of the frozen snapshot is shared, and the start-state hash is recomputed (the worker
  re-checks it). Duplicate seeds and a seed equal to the discovery stream are refused.
- **Discovery vs validation:** discovery is the existing single-seed evaluation (the snapshot's
  stream). Validation seeds are derived from a different string space and never equal it, so the
  validation futures are independent of the future the plan was chosen on. The optimiser is not
  re-run per seed: this validates *one* candidate, it is not a multi-seed optimiser. Validating the
  top candidate after choosing it is a fair test of that candidate (no selection on the validation
  seeds); comparing several candidates on the same validation seeds and picking the best would
  reintroduce selection bias, and the UI does not offer it.
- **Pairing:** per seed, baseline and candidate start from the identical state and the candidate
  applies the same `linehaul.set_standby` commands as in the optimiser (`planCommands`, same
  command-id prefix). On the discovery stream this reproduces the optimiser's own numbers exactly
  (tested).
- **Random-number limits:** one sfc32 stream serves every random system, and several draws depend
  on state (a lane draws only while below `max_open` open transfers; quantities depend on stock and
  room). Once the plans' states diverge they consume the stream differently, so common random
  numbers hold only at the start. Measured on the golden fixture: demand (transfers or pallets
  planned) differed between the plans on 19 of 20 seeds; the candidate saw slightly *more* demand
  (+0.5 transfers, +8.1 pallets planned on average over 10 seeds), because faster pickups keep
  lanes under their cap. Every seed records `workload_diverged`; the result counts them. Per-system
  streams would fix this but change every recorded run, so they are a follow-up (§8.8).
- **Statistics** (`stats.ts`, pure): per metric, means and medians of both plans, the paired
  difference d = candidate − baseline (mean, median, sample SD, standard error), the **95 % paired
  Student t interval** mean(d) ± t(0.975, n − 1)·s/√n (table for df 1–29, checked against the t
  density by numerical integration in tests), relative change (null when the baseline mean is not
  positive), and seeds better / worse / tied. Missing or non-finite observations are excluded and
  counted. Identical differences (zero variance, up to floating-point error) are flagged
  `degenerate` and are never evidence (§8.9). Decisions use the unrounded statistics; values are
  rounded for display only.
- **Verdict** (`robustnessVerdict`, on mean pickup wait, the optimiser's objective), first match:

  | Verdict | Condition |
  |---------|-----------|
  | `constraint_failure` | a hard constraint fails on any seed (commands accepted, engine invariants, ≥ 95 % of that seed's baseline pallets, no extra cancellations, baseline invariants) |
  | `insufficient_data` | fewer than 5 valid pairs |
  | `improved` | interval entirely below 0 **and** mean reduction ≥ 2 s and ≥ 5 % (the existing thresholds) |
  | `improved_below_threshold` | interval entirely below 0, thresholds not met (statistically but not practically better) |
  | `regressed` | interval entirely above 0 |
  | `inconclusive` | otherwise, including a degenerate (zero-width) interval |

  Reliably worse secondary metrics are listed as trade-offs. With a constraint failure the reasons
  name each failing seed, the constraint and its numbers, whether demand diverged on it, and the
  pickup-wait reading as context, explicitly not the verdict.
- **Budget:** 1–30 seeds (tiers Quick 5, Standard 20, Extended 30; the cost — simulations and
  simulated minutes — is shown before starting); 2 simulations per seed; batches of 16 jobs (the
  pool's per-request cap); one request at a time; 600 s limit (`EVALUATION_TIMEOUT`); cancel
  rejects with `CANCELLED` and no partial verdict.
- **Workspace** (`robustness.tsx`, store): seed tier, cost, progress by seed and stage (coalesced
  to ≤ 1 update per 250 ms, as in Phase 6.1), cancel, verdict with reasons and trade-offs, the
  pickup-wait interval drawn against zero and the thresholds, a per-metric table, every seed's
  observations, method, seed derivation and divergence count, and an "advisory, not stored"
  label. A new evaluation, opening a proposal or leaving AI mode cancels it. A proposal loaded from
  the API has no snapshot in the browser, so the panel says validation is unavailable.
- **Trust boundary:** the result never reaches the API, cannot approve or apply anything, and the
  proposal's status is unchanged (tested: the only API write in the flow is the existing
  `POST /proposals`). The API and its schema are unchanged.

### 8.3 Results on the golden fixture

`pnpm bench:twin -- --robustness` (Node, inline, deterministic): golden snapshot `1ab6d3065153`,
discovery `evaluation-recommended.json` (15 simulated minutes), candidate c4, root seed `bench`.
Discovery reports c4 at 67.6 s → 50 s mean pickup wait (−26 %).

| Seeds | Verdict | Mean change in pickup wait | 95 % interval | Better / worse / tied | Failed seeds | Demand diverged |
|-------|---------|----------------------------|---------------|-----------------------|--------------|-----------------|
| 1 | `insufficient_data` | −9.2 s (−14.5 %) | — | 1 / 0 / 0 | — | 1 |
| 5 | `improved` | −13.5 s (−20.7 %) | −19.2 … −7.8 s | 5 / 0 / 0 | — | 5 |
| 10 | `constraint_failure` | −15.0 s (−22.1 %) | −18.6 … −11.4 s | 10 / 0 / 0 | 6 | 9 |
| 20 | `constraint_failure` | −15.5 s (−22.7 %) | −17.6 … −13.4 s | 20 / 0 / 0 | 6 | 19 |
| 30 | `constraint_failure` | −15.4 s (−22.6 %) | −17.1 … −13.7 s | 30 / 0 / 0 | 6 | 26 |

- The gain is real but smaller than discovery reported (−22.7 % against −26 %), as expected for a
  plan selected on one future.
- On seed 6 the candidate delivers 176 pallets against a floor of 181 (baseline 190), so the plan
  fails the service-level hard constraint; 5 seeds miss it, 10 or more find it. Averaged, the
  pallets delivered rise (+3.6 over 10 seeds): averaging would have hidden the failure.
- Every repetition was byte-identical (runtime field excluded).
- An exploratory run on a live snapshot (not reproducible): a plan recommended at −17.9 % held
  −4.5 % over 20 seeds (interval −8.4 % … −0.6 %) and failed service level on 3 seeds.

### 8.4 Benchmarks (Apple M2 × 8, 8 GiB, macOS 26, headless Chromium 153, 2026-11-01)

`caffeinate -i -s pnpm bench:twin-robustness -- --runs 3`: production build (`next start`), live
app in AI mode at 1×, API stubbed; the production `evaluateRobustness` / `optimizeStandby` and the
real `WorkerPool` (its workers load the app's own bundle, wrapped only to time jobs), injected as an
esbuild bundle; identical workload for every row (golden snapshot, discovery and candidate c4,
horizon 15 simulated minutes, root `bench`); a fresh page per configuration; median of 3 runs.
Load average 5.8 before, 7.3 after (the owner's Docker data stack was running); the power log shows
no sleep or wake during the run (21:45–21:51). Every row's result id was identical across its runs.

| Configuration | Verdict | Wall time (median / min) | Per seed | Simulated ticks/s | Worker utilisation | Peak jobs | Long tasks | Frame p95 | Late frames | Renderer RSS peak |
|---------------|---------|--------------------------|----------|-------------------|--------------------|-----------|------------|-----------|-------------|-------------------|
| Single-seed optimisation (discovery), ×4 | recommended | 1.7 / 1.6 s | — | 31,216 | 0.79 | 4 | 0 | 16.8 ms | 0 % | 308 MB |
| 1 seed, ×4 | `insufficient_data` | 0.8 / 0.8 s | 0.82 s | 22,045 | 0.49 | 2 | 0 | 16.8 ms | 0 % | 311 MB |
| 5 seeds, ×4 | `improved` | 3.0 / 2.4 s | 0.59 s | 30,392 | 0.86 | 4 | 0 | 16.7 ms | 1.0 % | 323 MB |
| 10 seeds, ×4 | `constraint_failure` | 4.9 / 4.5 s | 0.49 s | 36,522 | 0.98 | 4 | 0 | 16.7 ms | 0.4 % | 339 MB |
| 20 seeds, ×4 | `constraint_failure` | 9.5 / 9.3 s | 0.47 s | 38,079 | 0.97 | 4 | 0 | 16.8 ms | 0.4 % | 352 MB |
| 30 seeds, ×4 | `constraint_failure` | 13.0 / 12.0 s | 0.43 s | 41,643 | 0.98 | 4 | 0 | 16.8 ms | 0.5 % | 380 MB |
| 20 seeds, ×1 | `constraint_failure` | 29.7 / 25.1 s | 1.49 s | 12,122 | 1.00 | 1 | 0 | 16.7 ms | 0.4 % | 343 MB |
| 20 seeds, main thread | `constraint_failure` | 28.7 / 27.8 s | 1.43 s | 12,558 | — | 1 | 20 (1,301 ms), longest 86 ms | 33.3 ms | 8.4 % | 285 MB |

| Cancellation (30 seeds, ×4, cancelled after 3 s) | Median | Max |
|--------------------------------------------------|--------|-----|
| Promise rejected with `CANCELLED` after abort | 0.3 ms | — |
| Last worker quiet after abort | 71 ms | 76 ms |

- **Scaling:** wall time grows linearly with seeds (≈ 0.43–0.49 s per seed on 4 workers from 10
  seeds up); 20 seeds take 9.5 s on 4 workers against 29.7 s on one worker and 28.7 s on the main
  thread (3.0–3.1×). Utilisation is 0.97–0.98 from 10 seeds up; 1 and 5 seeds cannot fill 4
  workers (2 and 10 jobs).
- **Main thread:** with workers, no long task and frame p95 16.7–16.8 ms at every seed count; the
  main-thread fallback makes 20 long tasks (longest 86 ms) and 8.4 % late frames. The live run
  stays at 9.9–10 ticks/s in every configuration.
- **Memory:** renderer RSS (page and workers, `ps`) peaks at 308–380 MB with workers, growing with
  the number of seeded states held for the result; on the main thread 285 MB.
- **Worker start-up** (to `ready`): 31–70 ms median per configuration.
- **Node, inline** (`pnpm bench:twin -- --robustness`, same workload, one thread): 1.37–1.51 s per
  seed; 20 seeds 29.6 s, 30 seeds 44.0 s; load average 5.6 before, 4.2 after.
- Variance (min against median): 1–18 % per row; the single-worker row's min (25.1 s) is 15 %
  below its median, a sign of contention from the background load.

### 8.5 Verification

| Check | Result |
|-------|--------|
| Statistics with hand-calculated fixtures (`stats.test.ts`, 16 tests) | Mean, median, sample SD, t quantiles (table checked against the t density by integration), paired summaries (e.g. d = −1…−5: interval −4.963 … −1.037, −21.43 %), degenerate and missing observations, relative change with a non-positive baseline, every verdict branch and its order |
| Multi-seed evaluation with the real engine (`robustness.test.ts`, 10 tests) | Seeds deterministic, distinct, never the discovery stream; invalid options refused; per-seed pairing recomputed directly with `simulate`; the optimiser's numbers reproduced on the discovery stream; frozen input untouched; byte-identical under a reversed parallel executor; batches of 16 + 4 jobs in seed order; progress stages; cancel → `CANCELLED`; stale snapshot and unknown candidate refused; metadata |
| Worker pool (`worker-pool.test.ts`, 3 new, 20 in all) | Per-job start states reach the worker; a forged start hash → `INVALID_SNAPSHOT`; multi-seed on workers identical to inline; cancelling one request leaves the other running |
| Workspace store (`store.test.ts`, 5 new, 7 in all) | The chosen candidate and seed count are run with coalesced progress; cancel leaves no verdict; a worker failure leaves no verdict and offers the main thread explicitly; a new evaluation stops a running validation and clears an old verdict; nothing runs without a snapshot |
| Browser (`ai.spec.ts`, Phase 6.2 block, 4 tests) | Validate: progress, statistics, verdict, a reproducible id; the only API write is the existing `POST /proposals` and the proposal stays "Awaiting review"; cancel leaves no verdict and the live run keeps going; worker failure → explicit main-thread alternative, labelled; a proposal loaded from the API says validation is unavailable |
| `pnpm check` (format, lint, typecheck, unit tests, build) | Exit 0; unit tests 380 passed (contracts 26, simulation 160, recorder 10, twin 52, web 132), 0 skipped |
| `pnpm test:e2e` (full) | Exit 0; 62 passed, 3 skipped: `ai-live`, `analytics-live` and `recording` need a live API (`TWIN_API_URL`, `ANALYTICS_API_URL`, `RECORDING_API_URL`) and run in CI's data-platform job |
| `CI=1 pnpm test:e2e ai.spec navigation.spec` | Exit 0; 22 passed |
| `pnpm bench:twin` and `-- --robustness` | Exit 0; every robustness repetition byte-identical |
| Python API | Unchanged (no file under `apps/api` touched); its checks run in CI's Python job |

### 8.6 Persistence and API

Not changed. The robustness result is advisory and stays in the browser: the API's `Evaluation`
schema is strict (`extra="forbid"`), and storing a browser-computed statistical summary as if the
server had verified it would cross the trust boundary. A stored version needs its own endpoint,
table and audit entry, with the server re-deriving the statistics from the per-seed observations
it receives (it still cannot re-simulate them; DEC-043).

### 8.7 Limitations

- One present state: seeds vary the future, not the starting conditions (fleet positions, stock,
  open transfers).
- Pairing is exact only at the start (§8.2); no variance reduction from common random numbers is
  claimed.
- The t interval assumes roughly normal paired differences; with 5 seeds it is wide. Seeds
  better / worse / tied are reported as a distribution-free view.
- Only mean pickup wait decides; secondary metrics are descriptive, without multiple-comparison
  correction.
- One candidate per run; the optimiser is not re-run per seed.
- Not persisted; a proposal loaded from the API cannot be validated without its snapshot.
- Advisory only: a verdict never approves or applies a plan. Human approval and the API's
  server-side validation and execute-once remain mandatory (§8.2, trust boundary).
- Benchmarks: headless Chromium on one machine (Apple M2, 8 GiB) with the data stack running in
  Docker.

### 8.8 Next increments

- Persist validations with server-side consistency checks of the statistics against the per-seed
  observations.
- Multi-seed discovery (choose the plan on several seeds, validate on others).
- Per-system random streams for true common random numbers (changes recorded runs; needs a
  migration of golden fixtures and replays).
- Vary the present state as well as the future.

### 8.9 Post-merge correction: degenerate intervals and unrounded decisions

**Branch:** `fix/p6-2-statistical-verdict` · **Base:** `main` @ `61c67d5` (PR #13 merged).
**Status:** MERGED as `2117d38` (PR #14, 2026-11-02).

**Root cause.** Two defects in the merged verdict, plus one numerical gap:

1. `evidenceOf` ignored `degenerate`. When every seed gives the same difference, the sample SD is
   zero and the t interval collapses to a point. That point was used as evidence and as a
   verdict, although the method does not apply.
2. `robustnessVerdict` read the display summary, so it compared values rounded to 3 decimals
   (mean change, interval bounds) and to 2 decimals (relative change) against zero and the
   thresholds. Evidence was computed unrounded, so the two could disagree.
3. `degenerate` was `sd === 0`. Differences that are equal in decimal (0.3 − 0.1, 0.7 − 0.5, …)
   differ by ~1e-16 in binary. They gave an SD of 1.2e-16 and an interval about 3e-16 wide that
   claimed certainty.

**Fix.**
- `pairedStats` returns the unrounded statistics. `roundForDisplay` rounds them for the result
  and the UI. `pairedSummary` is now `roundForDisplay(pairedStats(…))`, so the displayed values
  are unchanged.
- `robustnessVerdict` takes `PairedStats`. A type-only marker makes passing a display summary a
  compile error.
- The verdict branches on `evidenceOf(…)`, so verdict and evidence cannot disagree.
- `evidenceOf` returns `no_evidence` for a degenerate interval. The verdict for a degenerate
  primary metric with at least 5 pairs is `inconclusive`, and its reasons give the constant
  change and the seeds better / worse / tied.
- Differences count as identical when max(d) − min(d) ≤ 1e-9 · max(1, |min(d)|, |max(d)|): a
  combined tolerance, absolute (1e-9) for differences up to 1 in magnitude and relative (1e-9 of
  the largest magnitude) above. It is a numerical tolerance on the subtraction, far below any
  metric's display precision, not a statistical threshold.
- Reason text shows more decimals when one decimal would cross a threshold: "1.9996 s", not
  "2.0 s".
- The method, thresholds and verdict order are unchanged. `constraint_failure` still comes first
  and `insufficient_data` second. Trade-offs still list only metrics with evidence "worse", which
  now excludes degenerate intervals.

**Before and after** (same inputs; "before" run against the `61c67d5` code):

| Paired differences (5 seeds, lower is better) | Before: evidence / verdict | After: evidence / verdict |
|---|---|---|
| −2 s on every seed | better / `improved_below_threshold` | no evidence / `inconclusive` |
| −30 s on every seed | better / `improved` | no evidence / `inconclusive` |
| +3 s on every seed | worse / `regressed` | no evidence / `inconclusive` |
| +0.2 on every seed, with floating-point noise | worse / `regressed` | no evidence / `inconclusive` |
| mean −1.9996 s (displays −2.0), 20 % | better / `improved` | better / `improved_below_threshold` |
| mean −2.5 s, −4.996 % (displays −5.0 %) | better / `improved` | better / `improved_below_threshold` |
| interval high −0.0004 (displays 0) | better / `inconclusive` | better / `improved_below_threshold` |
| interval low +0.0004 (displays 0) | worse / `inconclusive` | worse / `regressed` |

On the golden fixture no metric is degenerate and no value lies within rounding of a threshold or
of zero, so the §8.3 results and §8.4 benchmarks are unchanged (re-checked with
`pnpm bench:twin -- --robustness`).

**Verification.**

| Check | Result |
|-------|--------|
| `stats.test.ts` (28 tests, 12 new) | Constant negative and constant positive differences: degenerate, `no_evidence` in both directions, verdict `inconclusive`; floating-point-equal differences degenerate, genuinely different ones not; `evidenceOf` truth table; 2 s and 5 % boundaries (exactly at the threshold: `improved`; 1.9996 s and 4.996 %, which display as 2 and 5: `improved_below_threshold`); interval bounds within 0.0005 of zero on either side; verdict always agrees with evidence; constraint failure still overrides a degenerate reading; insufficient data still first; display rounding equals the previous output |
| `robustness.test.ts` (12 tests, 2 new) | With the real engine, the verdict and reasons recomputed from the per-seed observations equal the result's; trade-offs are exactly the "worse" metrics; an executor giving constant per-seed differences (−2 s wait, +0.5 km empty) yields `inconclusive`, no evidence and no trade-off |
| Focused runs | twin `stats`, `robustness`, `executor`: 47 passed; web `worker-pool`, `store`: 27 passed |
| `pnpm check` | Exit 0; 394 unit tests passed (contracts 26, simulation 160, recorder 10, twin 66, web 132), 0 skipped |
| `pnpm test:e2e` (full) | Exit 0; 62 passed, 3 skipped (`ai-live`, `analytics-live`, `recording`: need a live API; run in CI's data-platform job) |
| `pnpm bench:twin -- --robustness` | Exit 0; verdicts, intervals, failed seeds and divergence counts for 1, 5, 10, 20, 30 seeds identical to §8.3; repeats byte-identical |
| Golden fixtures | Unchanged |

### 8.10 Follow-up: interval bounds shown with their sign

**Branch:** `fix/p6-2-statistical-verdict` (continued after PR #14) · **Base:** `main` @
`2117d38`.
**Status:** MERGED as `6b1794b` (PR #15, 2026-11-02; branch CI 5/5 jobs green).

**Problem.** After §8.9, verdicts use unrounded statistics, but the result still carried interval
bounds rounded to 3 decimals, and the UI showed them with 1 decimal. An exact upper bound of
−0.000389 s became `-0` (and `0` in JSON). Because `-0 < 0` is false, the UI showed "±0.0 s"
while the evidence read "reliably better".

**Fix (presentation only).**
- `roundBound` (`stats.ts`) keeps 3 decimals. When that would make a non-zero bound zero, it uses
  more decimals, up to 6. Below 1e-6 it keeps the exact value. It never returns −0.
- `formatBound` / `formatInterval` (`apps/web/src/lib/twin/view.ts`) keep the compact format
  ("−17.6 s"). Near zero they add decimals, up to 6, until the bound is non-zero ("−0.0004 s").
  Beyond that they show "−<0.000001 s". Only an exact zero reads "±0.0 s".
- The metric table and the chart's accessible label both use `formatInterval`.

The paired t method, the thresholds, the verdicts and the golden-fixture results are unchanged:
no bound there is within 0.0005 of zero.

**Verification.**

| Check | Result |
|-------|--------|
| `stats.test.ts` (29 tests, 1 new; 3 strengthened) | `roundBound`: −0.000389 → −0.0004, +0.000411 → 0.0004, +0.000389 → 0.0004, 4.1e-6 → 0.000004, −3e-8 kept, 0 and −0 → 0, ordinary bounds at 3 decimals, sign always preserved; the three near-zero interval tests now assert the displayed bound (−0.0004 / +0.0004) instead of 0 |
| `view.test.ts` (8 tests, 3 new) | `formatBound`: −0.000389 → "−0.0004 s", +0.000411 → "+0.0004 s", +0.000389 → "+0.0004 s", exact 0 and −0 → "±0.0 s", ordinary bounds identical to the compact format ("−17.6 s", "+0.26 km"), < 1e-6 → "+<0.000001 s"; `formatInterval` |
| Browser (`ai.spec.ts`, Phase 6.2 validation test) | The metric table's interval cell is two signed bounds, and the chart's accessible label contains the same text |
| Focused runs | twin `stats`, `robustness`, `executor`: 48 passed; web `lib/twin` (`store`, `view`, `worker-pool`): 35 passed |
| `pnpm check` | Exit 0; 398 unit tests passed (contracts 26, simulation 160, recorder 10, twin 67, web 135), 0 skipped |
| `pnpm test:e2e` (full) | Exit 0; 62 passed, 3 skipped (`ai-live`, `analytics-live`, `recording`: need a live API; run in CI's data-platform job) |
| Golden fixtures and benchmark results | Unchanged (no fixture file touched; the golden bounds are at least 7 s from zero, so their 3-decimal display is unchanged) |
