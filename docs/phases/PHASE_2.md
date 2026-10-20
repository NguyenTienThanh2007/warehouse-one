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
| GitHub Actions | NOT RUN (branch not pushed) |

### Unresolved risks and open work

1. **Renderer integration is not done (milestone D).** The 3D view still draws vehicles at their
   chargers and pallets with the Phase 1 bottom-up convention, while the simulation now moves
   vehicles and tracks exact slots. Until D lands, the view does **not** show vehicle positions
   or in-flight pallets from authoritative state. The e2e vehicle-count assertion was updated from
   6 to 4 (trucks are now dynamic and not yet rendered).
2. Operator UI (task queue, orders and trucks, rejection explanations), screenshots, render and
   simulation benchmarks for operations, and an operations golden fixture are not done.
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
