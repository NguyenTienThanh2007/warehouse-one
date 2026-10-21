# Roadmap

Each phase is developed on `feature/p<N>-…`, reviewed through a pull request, and merged into
`main` only after its acceptance checks pass and the project owner approves.

| Phase | Branch | Theme | Status |
|-------|--------|-------|--------|
| 0 | `feature/p0-foundation` | Foundation & architecture | **Accepted**, merged (`c512733`) |
| 1 | `feature/p1-3d-world` | Premium 3D world | **Accepted**, merged (`d80a7f2`, follow-up `0463395`) |
| 2 | `feature/p2-simulation` | Living warehouse simulation | **Merged** (PR #4, `d2dc4d9`, 2026-10-21; `main` CI 4/4 green) |
| 3 | `feature/p3-data-engineering` | Real data engineering | **Accepted**, merged (PR #5, `0b25fa4`; main CI green) |
| 4 | `feature/p4-analytics` | Advanced operations analytics | **Planning** (see `docs/phases/PHASE_4.md`) |
| 5 | `feature/p5-multi-site-world` | Multi-site logistics world | Not started |
| 6 | `feature/p6-ai-digital-twin` | AI logistics brain + digital twin scenarios | Not started |
| 7 | `feature/p7-production` | Production & portfolio release | Not started |

## Phase 1 — Premium 3D world (accepted)

**Deliverables:** procedural or licensed assets for the building shell, racks, pallets, docks,
forklift and truck; lighting and materials per the visual spec; camera presets and follow mode;
object selection and inspection; asset pipeline (instancing, glTF + meshopt/KTX2 where used,
attribution file); adaptive quality tiers; HUD polish; responsive camera framing on phones.

**Acceptance:** scene renders correctly; smooth camera; selectable objects; no obvious clipping;
desktop flows pass in Playwright; five bookmark screenshots captured; FPS and p95 measured at 100,
300 and 1,000 entities with the GPU string; visual review against the spec checklist; reference
comparison recorded honestly. Results are in `docs/phases/PHASE_1.md`.

## Phase 2 — Living warehouse simulation (merged)

Equipment became stateful (tasks, routing, battery), pallets got exact positions, docks gained
truck arrivals and departures, and the renderer draws all of it from simulation state. Workers were
deferred. Record and limitations: `docs/phases/PHASE_2.md`.

## Phase 3 — Real data engineering (accepted)

PostgreSQL event store and transactional outbox, Kafka (KRaft), idempotent consumers with a DLQ,
Parquet bronze on MinIO, dbt silver/gold, Airflow refresh/backfill/reconciliation, and an end-to-end
smoke test. PR #5 merged as `0b25fa4`; main CI passed. Evidence and limitations:
`docs/phases/PHASE_3.md`.

## Phases 2–7

Summarised from the master brief. Detailed plans are written at the start of each phase in
`docs/phases/PHASE_<N>.md`.

- **2:** orders, pallets, forklifts with grid/graph pathfinding, workers, trucks and docks; save/load;
  invariants and replay tests for every new aggregate; Build and Operate modes.
- **3:** event log and outbox in PostgreSQL, Kafka (KRaft), idempotent consumers with DLQ, MinIO
  Parquet bronze, dbt silver and gold with tests, Airflow for backfill and reconciliation,
  recovery and duplicate tests.
- **4:** dashboards reconciled with dbt marts, live vs. historical labelling, freshness,
  pipeline health and alerts. Define metrics without pretending the current single-site model is
  already city-scale.
- **5:** multi-site spatial foundation and first visible connected logistics network: facility/site
  hierarchy, a site overview, multiple warehouse/yard/cross-dock areas, explicit inter-site links,
  and deterministic transport between hubs. Preserve per-site operational invariants.
- **6:** provider-agnostic AI service with structured proposals, validation and approval; deterministic
  optimisers (routing/slotting) with benchmarks; city-scale digital-twin view, time travel/replay,
  isolated scenarios, comparisons, capacity planning and stress tests.
- **7:** polish, security review, observability, deployment, documentation, demo and
  commercialisation assessment.


## Phase 4 — Advanced operations analytics (planning)

A read-only analytics API and dashboard backed by published dbt gold snapshots. Define a metrics
catalogue, verify API-to-mart reconciliation, distinguish live simulation from historical analytics,
and expose freshness and pipeline health. Detailed scope and acceptance:
`docs/phases/PHASE_4.md`.

## Multi-site roadmap decision

The current scene is one warehouse. Multi-site work is now explicit rather than an implied future
feature: Phase 5 builds the site/facility network and first visible connected multi-area slice;
Phase 6 expands it into a city-scale digital twin and combines it with AI recommendations, replay,
scenario comparison and capacity planning. Phase 4 remains focused on analytics, but its contracts
must not hard-code a single facility as a permanent product constraint.
