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
