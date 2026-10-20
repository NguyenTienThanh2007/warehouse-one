# Roadmap

Each phase is developed on `feature/p<N>-…`, reviewed through a pull request, and merged into
`main` only after its acceptance checks pass and the project owner approves.

| Phase | Branch | Theme | Status |
|-------|--------|-------|--------|
| 0 | `feature/p0-foundation` | Foundation & architecture | **In review** (see `docs/phases/PHASE_0.md`) |
| 1 | `feature/p1-3d-world` | Premium 3D world | Not started; blocked on Phase 0 approval |
| 2 | `feature/p2-simulation` | Living warehouse simulation | Not started |
| 3 | `feature/p3-data-engineering` | Real data engineering | Not started |
| 4 | `feature/p4-analytics` | Advanced operations analytics | Not started |
| 5 | `feature/p5-ai-brain` | AI logistics brain | Not started |
| 6 | `feature/p6-digital-twin` | Advanced digital twin | Not started |
| 7 | `feature/p7-production` | Production & portfolio release | Not started |

## Phase 1 — Premium 3D world (next)

**Deliverables:** procedural or licensed assets for the building shell, racks, pallets, docks,
forklift and truck; lighting and materials per the visual spec; camera presets and follow mode;
object selection and inspection; asset pipeline (instancing, glTF + meshopt/KTX2 where used,
attribution file); adaptive quality tiers; HUD polish; responsive camera framing on phones.

**Acceptance:** scene renders correctly; smooth camera; selectable objects; no obvious clipping;
desktop flows pass in Playwright; five bookmark screenshots captured; FPS and p95 measured at 100,
300 and 1,000 entities with the GPU string; visual review against the spec checklist; reference
comparison recorded honestly.

## Phases 2–7

Summarised from the master brief. Detailed plans are written at the start of each phase in
`docs/phases/PHASE_<N>.md`.

- **2:** orders, pallets, forklifts with grid/graph pathfinding, workers, trucks and docks; save/load;
  invariants and replay tests for every new aggregate; Build and Operate modes.
- **3:** event log and outbox in PostgreSQL, Kafka (KRaft), idempotent consumers with DLQ, MinIO
  Parquet bronze, dbt silver and gold with tests, Airflow for backfill and reconciliation,
  recovery and duplicate tests.
- **4:** dashboards reconciled with dbt marts, live vs. historical labelling, freshness and
  pipeline health, alerts.
- **5:** provider-agnostic AI service, structured proposals, validation, approval workflow,
  evaluations, and deterministic optimisers (routing, slotting) with benchmarks.
- **6:** time travel and replay UI, isolated scenario runs, comparisons, capacity planning, stress tests.
- **7:** polish, security review, observability, deployment, documentation, demo and
  commercialisation assessment.
