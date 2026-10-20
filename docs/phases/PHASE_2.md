# Phase 2 — Living Warehouse Simulation

**Branch:** `feature/p2-simulation` · **Base:** `main` @ `04633958f0bc0cc81aab63da5a374d506ff94a54`
(Phase 1 + follow-up #3 merged; CI run 39429621800 green)
**Status:** IN DEVELOPMENT. Sections marked *(plan)* describe intent, not results.

## 1. Gate A (verified 2026-10-20)

| Check | Result |
|-------|--------|
| PR #2 (Phase 1) | MERGED → `d80a7f2`; head `f8ed81c`; CI run 39424947352 on the merge: 4/4 green |
| PR #3 (camera-test fix) | MERGED → `0463395`; head `1fee7ec`; PR CI run 39427678721 green; `main` CI run 39429621800: 4/4 green, e2e 18/18, no flaky results |
| Auto-merge | Never enabled on either PR |
| Working tree | Clean before branching |
| Stale docs | PROJECT_STATUS, ROADMAP, CLAUDE.md, README and PHASE_1 header said Phase 1 was "in review"; updated in the first Phase 2 commit |

## 2. Starting point (from inspection)

- **Engine:** pure `step(config, state, commands)`, a copy-on-write `TickDraft`, handlers for
  `inventory.receive/move/adjust`, one system (synthetic workload), snapshots with hash and
  invariant checks, and replay from the command log.
- **State:** `inventory[location][sku] = quantity` (per bay, no pallet identity), RNG, sequence and
  aggregate versions.
- **Facility master data (DEC-014):** building, rack spec, docks, and equipment parked at static
  positions (including two trucks).
- **Renderer:** pallets placed with a bottom-up *display convention* (DEC-015); vehicles static.
- **Golden fixture:** `data/fixtures/foundation-demo` uses a config **without** `facility`.

## 3. Plan *(plan)*

**Preservation strategy.** All new operational state lives in an optional `state.ops`, created only
when `config.facility` exists. Configs without facility data (the Phase 0 golden scenario) run the
unchanged Phase 0 code path, so their state hash and events stay byte-identical.

| Milestone | Content |
|-----------|---------|
| A Domain | Pallets with stable IDs and explicit positions (rack slot, staging position, forks, trailer); equipment state; tasks; trucks; docks; orders; invariants; the inventory table kept as a checked projection of slotted pallets |
| B Movement | Navigation graph derived from facility geometry (aisles, cross aisles, dock paths, charging road); deterministic Dijkstra; tick-based movement in integer millimetres; node holding, zone exclusivity and replanning for conflicts |
| C Workflows | Relocation (slot → slot), put-away (staging → slot), picking (slot → staging), with dispatcher assignment by path distance |
| E Trucks/docks | Inbound truck → unload → put-away; outbound order → pick → load → depart; dock exclusivity (moved before D so the UI shows real truck states) |
| D 3D/UI | Interpolated vehicle poses from authoritative state; pallets at exact positions; task queue, orders/trucks, rejection explanations, inspectors |
| F Verify | Unit, integration and e2e tests (state-based waits, retries off), screenshots, benchmarks, docs, draft PR |

**Order change:** E comes before D because the operator UI and dock rendering depend on truck
state existing.

**Workers (§4.6):** deferred to a later Phase 2 milestone. Forklift, inventory, task and dock
workflows come first, as the brief allows.

## 4. Stabilisation (2026-10-20, second session)

**Scope:** make the WIP engine (`eba129e`) reliable. No UI, AI or infrastructure work.

### Failures reproduced

| Test | Symptom |
|------|---------|
| Outbound workflow | Order never shipped within 10,000 ticks |
| 20,000-tick showcase soak | 0 tasks completed after the last change to `resolveWait` |

### Root cause

A **livelock in two-way single-lane aisles**. Traced on the outbound case: `fl-03` and `rt-01` met
head-on in aisle `a1`. The deadlock rule made `rt-01` back off one node, but `fl-03`'s route
continued *through* that node, and `rt-01`'s route led straight back, re-entering the vacated node
in the same tick. The standoff repeated for more than 2,300 ticks. Vehicles cannot pass each other
in a single-lane corridor, so no "step back one node" heuristic can resolve a head-on meeting there.
Two further attempts (corridor locking with refuge/yield) fixed individual traces but failed a
12-seed sweep: a deadlock victim often has no legal refuge in a two-way grid.

### Fix: one-way circulation (DEC-019)

- **Directed aisles.** The west cross aisle runs north, the east cross aisle south. The back aisle
  runs east, the front aisle west, and middle aisles alternate. The graph is validated as
  **strongly connected**.
- **Two-way dead ends.** Dock paths and the charging road stay two-way, as exclusive zones claimed
  one node early (unchanged).
- **No head-on meetings.** A vehicle only waits behind one moving the same way, behind one handling
  a pallet, or for a dead-end zone whose occupant can always leave.
- **Dispatcher (DEC-020).** At most one task touches a dock at a time, so no vehicle queues on the
  front aisle for a busy dock.
- **Simplified wait handling.** The refuge/yield/back-off machinery is removed. After a long wait
  behind a *stuck* vehicle, the only remaining rule is a bounded detour (≤ 2 × remaining + 30 m).

### Related defects found by the sweep

- **Benchmark workload never produced work.** `bench-1000` relocations targeted random bays, almost
  all full (24 free slots in 128 bays), so they were rejected. Targets are now bays with room. The
  old scenario test passed vacuously, because a count stays constant when nothing moves.
- **Workloads were calibrated for two-way routes** (~300 ticks per task). Measured one-way tasks
  take ~1,000 ticks. Re-calibrated from measurements (3 seeds × 20,000 ticks):

  | Scenario | Rates | Fleet utilisation | Backlog at 5k/10k/15k/20k ticks |
  |----------|-------|------------------:|-------------------------------|
  | showcase | inbound and outbound every 3,600 ticks, relocation every 1,800, 2–4 pallets | 63–70% | 4–11 tasks, bounded |
  | bench-1000 | relocation every 360 ticks | 83–85% | ≤ 5 tasks |

### Regression tests (`packages/simulation/src/ops/regressions.test.ts`)

| Test | On the pre-fix commit `eba129e` | Now |
|------|-------------------------------|-----|
| Two-way travel exists only inside exclusive dead-end zones (3 layouts) | FAIL | PASS |
| Liveness, 15,000 ticks: max wait < 300 ticks, work in every 2,500-tick window, completions ≥ 85% of created, backlog < 20 (3 showcase seeds, 2 bench-1000 seeds) | FAIL (5/5) | PASS |
| Identical runs, snapshot mid-operation then resume, runner replay with operator commands | PASS | PASS |

**Seed sweep after the fix** (12 showcase seeds + 4 bench-1000 seeds, 20,000 ticks): longest wait
≤ 156 ticks (previously up to 8,655), no invariant violations.

### Check results (local, Apple M2)

| Check | Result |
|-------|--------|
| `pnpm check` (format, lint, typecheck, build) | PASS |
| Unit tests | PASS: contracts 26, simulation 102, web 39 |
| Python: ruff, ruff format, mypy `--strict`, pytest 20, integration 2 (PostgreSQL) | PASS |
| Pydantic mirror of the 10 new event types | PASS; drift test now also checks that the event-type sets and aggregate types match |
| Playwright e2e on GPU, retries disabled | PASS 18/18 |
| Playwright e2e under `CI=1` (SwiftShader), retries disabled | PASS 18/18 (3.9 min) |
| Phase 0 golden fixture | unchanged (byte-identical to base) |
| GitHub Actions | Run 39463588226 on `1be594a` (manual dispatch): TypeScript, Python + migrations, Docker Compose PASS; e2e FAILED 22/23 (see below). Re-run on the fix: see the commit message / PR |

### Unresolved risks and open work

1. *(Resolved in §5.)* **Renderer integration is not done (milestone D).** The 3D view still draws vehicles at their
   chargers and pallets with the Phase 1 bottom-up convention, while the simulation now moves
   vehicles and tracks exact slots. Until D lands, the view does **not** show vehicle positions
   or in-flight pallets from authoritative state. The e2e vehicle-count assertion was updated from
   6 to 4 (trucks are now dynamic and not yet rendered).
2. *(Resolved in §5.)* Operator UI (task queue, orders and trucks, rejection explanations),
   screenshots, render and simulation benchmarks for operations, and an operations golden fixture
   are not done.
3. **Deadlock freedom is argued and tested, not proven.** The one-way design removes head-on
   conflicts; the evidence is 16 sweep runs, 5 regression seeds and the soak. Exotic congestion
   (e.g. many more vehicles than aisles) is untested.
4. **Throughput is lower than two-way routing would suggest.** One-way loops lengthen trips, and
   at most one task runs per dock at a time. The calibration reflects this. Comparing dispatch and
   flow policies is the planned next product capability.
5. **Local environment quirk.** macOS keeps re-applying the `hidden` flag to the API's `.venv`,
   and this Python release skips hidden `.pth` files, so `uv run pytest` fails locally with
   `ModuleNotFoundError`. Workaround: `chflags -R nohidden apps/api/.venv` and
   `apps/api/.venv/bin/python -m pytest`. CI (Linux) is unaffected.

## 5. Milestone D: 3D world and operator UI on `state.ops` (2026-10-20, third session)

### 5.1 Longest-task target (soak test)

The stabilisation commit `c4518dc` relaxed the soak assertion `longestService < 1800` to `< 2500`
without owner approval. **It is restored to 1,800** (`ops/workflows.test.ts`, showcase soak) and
passes. Evidence (assigned → completed, 20,000 ticks):

| Scenario | Seeds | Longest task | Tasks over 1,800 |
|----------|------:|-------------:|-----------------:|
| showcase | 12 | 1,549 ticks | 0 |
| bench-1000 | 2 | 1,864 ticks (`regression-1`), 1,822 (`regression-2`) | 1 per run |

**The two bench-1000 tasks are not congestion.** Both are relocations across the layout, traced
phase by phase:

| Task | Empty trip to pick-up | Loaded trip | Distance driven | Ticks spent waiting |
|------|----------------------:|------------:|----------------:|--------------------:|
| `tsk-000030` (fl-03, seed 1), 1,864 ticks | 700 ticks, 138.5 m | 1,108 ticks | 308 m | 55 (3%) |
| `tsk-000050` (fl-01, seed 2), 1,822 ticks | 740 ticks, 148.1 m | 1,038 ticks | 303 m | 67 (4%) |

Routes are shortest paths (travel / shortest path = 1.00). With one-way circulation (DEC-019) the
longest pick-face-to-pick-face trip is 193.7 m in bench-1000 and 174.5 m in the showcase. At
200 / 160 mm per tick that is ~2,180 and ~1,960 ticks of *pure driving* in the worst case, before
handling. So a 1,800-tick bound is a property of the current layout and workload, not a guarantee
of the routing. The showcase meets it with ~250 ticks of margin; bench-1000 cannot always.

**Owner decision needed:** keep 1,800 ticks for the showcase only (current state, no assertion on
bench-1000), or adopt a layout-derived target (for example, free-flow trip time + a congestion
allowance). No bench-1000 service-time assertion was added in either direction.

**Completed-task floor (150 → 60 in `c4518dc`).** The floor is tied to how much work the seeded
workload generates, and `c4518dc` re-calibrated that workload for one-way routing:

| Workload (showcase) | Inbound trucks | Outbound orders | Relocations | Pallets per truck/order | Tasks generated per 20,000 ticks |
|---------------------|----------------|-----------------|-------------|-------------------------|---------------------------------|
| Before (`eba129e`) | every 1,800 ticks | every 1,800 | every 600 | 3–5 | ~210 (estimated from rates) |
| Now | every 3,600 | every 3,600 | every 1,800 | 2–4 | 77–94 measured (12 seeds), +4 from opening commands |

150 was ~72% of the old demand; 60 is ~73–78% of the new measured demand (completed: 78–93 across 12
seeds; all 5 orders shipped in every seed). So the number moved with the workload, not to hide a
failure. It is still a loose, hand-picked floor.

**What the soak detects, and how** (showcase, 20,000 ticks):

| Failure | Assertion |
|---------|-----------|
| Stalled progress / deadlock / livelock | a task completes in every 2,000-tick window (10 windows); longest wait at one node < 300 ticks |
| Work left undone | completed / created > 0.85; tasks open at the end < 20 |
| Slow tasks | longest assigned → completed < 1,800 ticks |
| Inventory, pallet, reservation, dock and vehicle invariants | `checkInvariants` every 100 ticks (throws) and at the end |
| Workload generator producing too little work | completed > 60 |

**Accounting fix (this review).** The soak and the multi-seed liveness test counted tasks *completed*
from the opening commands but not tasks *created* by them, which overstated the completion ratio by
up to ~5% (measured ratios ranged 0.95–1.01, above 1 being impossible). Both now count the opening
step's tasks. This makes the ratio check stricter; all tests still pass.

**Workflow-completion assertions (approved and applied).** The soak now runs on all 12 seeds
(20,000 ticks each) and checks outcomes from events and the final state, in addition to everything
above:

- every outbound order created at least **6,000** ticks before the end has shipped and left state;
- every inbound truck that entered the yard at least **3,500** ticks before the end has departed and
  left state;
- every task type (unload, put-away, pick, load, relocate) completed at least once;
- tasks from the opening commands count in both created and completed totals;
- longest task < 1,800 ticks (showcase only); completed > 60 kept as a secondary sanity check on the
  workload generator, not as the proof of liveness.

Measured on the 12 seeds: orders take 1,575–5,511 ticks from creation to shipping (90th percentile
4,757); inbound trucks take 352–3,125 ticks from arrival to departure. Orders are slow because the
dispatcher lets one task at a time touch a dock (DEC-020): an order's 4–8 picks and loads run in
series, and 72% of their task time is spent waiting for dispatch. No order or truck was stuck.

An earlier attempt with a 3,000-tick margin for both failed on 10 of 12 seeds: the order created at
tick 16,800 was still loading at the end. That margin had been derived from a 4-pallet order in an
**idle** facility (~2,050 ticks), the wrong reference for a loaded one.

**The 6,000 / 3,500 margins are regression guards derived from the observed 12-seed showcase
workload, not universal performance guarantees.** They catch orders or trucks that never finish
(or slow down markedly); they do not bound lead time. Changing the workload, layout or dispatcher
(including any revision of DEC-020) requires re-measuring and revalidating them.

### 5.2 What changed

| Area | Change |
|------|--------|
| Vehicles | Drawn every frame from `equipmentPose`, interpolated between the last two ticks (DEC-021); forks are a separate part lifted to the simulated fork height |
| Pallets | Rack and staging pallets at `palletWorld` positions (exact slot / lane); pallets on forks follow the interpolated vehicle; pallets inside trailers are hidden. The Phase 1 bottom-up convention remains only for configs without facility data |
| Trucks and docks | Trucks drawn from `truckPose` (yard → docking → docked → departing); departed trucks disappear; door lights show free (green) or occupied (amber) from `ops.docks` |
| Picking | Vehicles and trucks have moving pick volumes and outlines; trucks are selectable |
| Operations panel | Tabs: task queue (status, vehicle, age), orders (progress, cancel, recently finished from events), trucks & docks, new work (outbound order, inbound truck) |
| Commands | `submitCommand` through the runner (DEC-022): order.create, order.cancel, truck.schedule_inbound, pallet.relocate and inventory.receive (bay inspector). Results show Queued / Accepted / Rejected with code, engine message and an operator explanation |
| Inspectors | Bay: pallets by slot, reserved slots, relocate / receive. Vehicle: live status, task, load, battery, position, odometer, waits. Dock: truck and staging lane. Truck: status, time in status, dock, pallets aboard, order |
| KPIs | Stock in racks, utilisation, bays in use, fleet busy (from `ops.equipment`), open tasks, trucks on site / docks occupied. Trucks are no longer counted from config |
| Runner | `tickProgress` (read-only, for interpolation) |
| Read-only hooks | `window.__WAREHOUSE_ONE_SIM__` (state, config, commands, finished orders, authoritative poses) and `window.__WAREHOUSE_ONE_SCENE__.moving` (what was drawn), for tests |

Unchanged: camera presets, quality tiers, scenarios, the Phase 0 golden fixture (byte-identical).

### 5.3 Verification (local, Apple M2)

| Check | Result |
|-------|--------|
| `pnpm format:check`, `lint`, `typecheck`, `build` | PASS |
| Unit tests | PASS: contracts 26, simulation 121 (was 102; includes the 12-seed soak), web 56 (was 39) |
| `git diff --check` | clean |
| New unit tests | `world/ops-view.test.ts` (11): poses at alpha 0/1 equal the authoritative poses, interpolation never exceeds the simulated speed, forks rise while handling, static pallets equal `palletWorld` and the inventory table, carried pallets sit on the carrying vehicle's forks, trucks equal `truckPose`, docked trucks match their dock, scene counts, free stock equals what an order may take. `lib/sim/store.test.ts` (+6): accepted, engine-rejected and schema-rejected commands, finished orders, previous-tick tracking. `runner.test.ts` (+1). `operations-golden.test.ts` (7) |
| Operations reference fixture | `data/fixtures/operations-demo`: 6,000 ticks, 197 events; order shipped, both trucks departed, 15 tasks completed, 4 scripted rejections, no invariant violations |
| Playwright e2e, GPU, retries disabled | PASS 23/23 (1.1 min), on the final tree |
| Playwright e2e, `CI=1` (SwiftShader), retries disabled | PASS 23/23 (6.3 min), on the final tree |
| Phase 0 golden fixture | byte-identical (`git diff data/fixtures/foundation-demo` empty; golden test passes) |
| Python (no Python changes) | ruff, ruff format, mypy: pass; pytest 20 passed; integration readiness (PostgreSQL) 1 passed; migration round-trip not run locally |
| GitHub Actions | Run 39463588226 on `1be594a` (manual dispatch): TypeScript, Python + migrations, Docker Compose PASS; e2e FAILED 22/23 (see below). Re-run on the fix: see the commit message / PR |

New browser tests (`tests/e2e/operations.spec.ts`, state-based waits only):
- Vehicles, trucks and carried pallets are drawn exactly at their simulated poses (paused, so no interpolation offset).
- A truck can be selected from the trucks panel and inspected.
- A rejected order shows `INSUFFICIENT_STOCK` with its explanation, and nothing changes.
- Stock received through the bay inspector and relocated from it is moved by a vehicle (empty facility).
- **Complete order through the UI:** inbound truck → unload → put-away → outbound order → pick → load → ship → truck departs. The final state reconciles: no pallets, orders, tasks or trucks on site, all docks free, the stock KPI and the scene both at 0. This test sets a 180 s timeout: the flow measures ~3,430 ticks in the engine, at least 43 s at the UI's maximum 8× speed (measured 42.9 s on GPU, 53.9 s on SwiftShader).

**CI failure on `1be594a` and fix.** On the GitHub runner the relocation test timed out
(60 s poll, 90 s test) with the pallet on a vehicle's forks: the workflow was progressing, slowly.
The runner executed the whole e2e suite in 17.1 min (6.3 min locally under `CI=1`) and the UI only
~24 ticks/s at 8× (3,430 ticks in 2.4 min): when frames take longer than 250 ms, simulated time per
frame is capped. The test also ran in the showcase, whose full scene renders slowest under
SwiftShader and whose queued work delays dispatch. It now runs in the empty facility (stock received
through the inspector, then relocated: 563 ticks, measured) with a 120 s poll and 180 s test budget,
derived from the measured CI rate (~24 s needed). Running it locally under `CI=1` then exposed a race
in the test itself: the pallet reaches its slot halfway through the drop, and the task completes a
few ticks later. The test now waits for both (pallet in the target slot and no open task) in one
state condition.

**Second CI run (39469515802, `92dadd7`): cancelled at the 20-minute job limit.** The runner was
slower still: the relocation took 1.5 min (~8 ticks/s) and the full order flow exceeded its
3-minute budget twice. Profiling locally under SwiftShader showed the main thread ~95% idle while
the renderer produced 3–4.5 FPS: the simulation was only fed time from animation frames, capped at
250 ms each, so a slow renderer slowed the simulation. Fixed at the cause (DEC-023): a 50 ms timer
feeds time on the same clock. With frames slowed to ~2 FPS locally, the run held 79.9 ticks/s at 8×
(requested 80). Test budgets were not raised.

Existing browser tests changed: no fixed sleep in "pallets follow the simulation" (it waits for 400 ticks); rendered pallets are compared with the simulation state while paused; the vehicle inspector checks live status instead of "Parked".

### 5.4 Benchmarks

**Simulation** (`pnpm bench:sim -- --ticks 5000`, Node 24, Apple M2):

| Scenario | mean µs/tick | p95 | p99 | ticks/s |
|----------|------------:|----:|----:|--------:|
| showcase (operations) | 135.1 | 264.1 | 364.3 | 7,401 |
| bench-100 (operations) | 9.6 | 13.3 | 40.8 | 103,718 |
| bench-300 (operations) | 24.9 | 35.2 | 110.3 | 40,095 |
| bench-1000 (operations) | 189.0 | 305.4 | 514.3 | 5,292 |

A later run (`evidence/phase-2/benchmarks/sim-2026-10-20.txt`) measured bench-1000 at
157.8 µs/tick (6,336 ticks/s) and the showcase at 124.6 µs/tick: runs differ by 10–20% on this laptop.
The UI at 8× needs 80 ticks/s; the slowest scenario has at least ~66× headroom.

**Render** (`pnpm bench:render`, Chromium 153 headless, ANGLE Metal, 1440×900 @2x, simulation
running, 4 moving vehicles, trucks on site in the showcase). Four runs were made; all reports are kept
in `docs/phases/evidence/phase-2/benchmarks/`.

| Run (report) | Samples | Conditions | bench-1000 High FPS |
|--------------|---------|------------|---------------------|
| A `16-24-10` | 10 s | the app was also open in the in-app preview browser, running at High on the same GPU | 38.1 |
| B `16-25-58` | 10 s | same as A (closing the preview failed; it was still open) | 38.0 |
| C `16-27-23` | 8 s | preview browser closed | **55.1** |
| D `16-28-51` | 10 s | preview browser closed | 60.0 |

Runs C and D:

| Scene | Tier | FPS C / D | p95 ms C / D | Long frames C / D | Draw calls |
|-------|------|-----------|--------------|-------------------|-----------:|
| bench-100 | High | 60.0 / 60.0 | 18.5 / 18.5 | 0 / 0 | 97 |
| bench-300 | High | 60.0 / 60.0 | 19.7 / 19.7 | 0 / 0 | 103 |
| bench-1000 | High | **55.1** / 60.0 | 25.4 / 23.4 | 19 / 2 | 111 |
| bench-1000 | Medium | 60.0 / 60.0 | 23.9 / 24.0 | 3 / 1 | 99 |
| bench-1000 | Low | 60.0 / 60.0 | 23.7 / 24.0 | 1 / 0 | 52 |
| showcase | High | 60.0 / 60.0 | 20.7 / 20.7 | 0 / 0 | 122 |

**Reading the results.** The first run with the preview closed (C) measured 55.1 FPS on
bench-1000 High; the next (D) measured 60.0. Both are real measurements; two runs are not enough to
say which is typical. Compared with Phase 1 (`PHASE_1.md` §4: 60 FPS, p95 20.1–20.8 ms), p95 on
bench-1000 is 3–5 ms higher on every tier in C and D. Runs A and B (~40 FPS on every High scene) are
*attributed* to GPU contention from the preview browser: closing it is the only change before C.
That is a correlation, not a proven cause. Medium and Low held 60 FPS in all four runs.

### 5.5 Screenshots

`docs/phases/evidence/phase-2/` (from `pnpm capture:operations`, each taken at a real simulated
moment, waited for on state): operating overview, docks with trucks, vehicle inspector, truck
inspector with the trucks panel, orders panel, rejected order with explanation, phone overview.

### 5.6 Limitations and open items

1. **bench-1000 longest-task target:** owner decision (§5.1).
2. **Workers (§4.6)** are not implemented (deferred in the plan).
3. **Phone layout:** the operations panel is hidden below 768 px wide; the inspector still works.
4. **Focus framing** can put racks between the camera and a vehicle in a narrow aisle (seen in screenshot 3).
5. **Render interpolation** shows motion up to one tick (100 ms simulated) behind the simulation (DEC-021).
6. Orders and trucks that finished are kept only from the events seen by this browser session (the last 8 orders); there is no history store yet.
7. `inventory.move` and `inventory.adjust` have no operator forms (still available through the command contract).
8. GitHub CI has not run on this branch.
9. bench-1000 High frame rate: one of two valid runs measured 55 FPS (§5.4).
10. Order lead time is not bounded by any test: the soak margins are completion guards (§5.1); dock serialisation (DEC-020) makes 4-pallet orders take up to ~5,500 ticks.
