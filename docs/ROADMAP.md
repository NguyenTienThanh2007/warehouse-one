# Roadmap

Each phase is developed on `feature/p<N>-…`, reviewed through a pull request, and merged into
`main` only after its acceptance checks pass and the project owner approves.

| Phase | Branch | Theme | Status |
|-------|--------|-------|--------|
| 0 | `feature/p0-foundation` | Foundation & architecture | **Accepted**, merged (`c512733`) |
| 1 | `feature/p1-3d-world` | Premium 3D world | **Accepted**, merged (`d80a7f2`, follow-up `0463395`) |
| 2 | `feature/p2-simulation` | Living warehouse simulation | **Merged** (PR #4, `d2dc4d9`, 2026-10-21; `main` CI 4/4 green) |
| 3 | `feature/p3-data-engineering` | Real data engineering | **Merged** (PR #5, `0b25fa4`) |
| 4 | `feature/p4-analytics-refresh` | Operations analytics (published, reconciled) | **Merged** (PR #9, `5490c54`, 2026-10-23; follow-up PR #10, `b2ccfdc`) |
| 5 | `feature/p5-multi-site-world` | Multi-site logistics world (first vertical slice) | **Merged** (PR #7, `5e9d0ef`; follow-up PR #8, `9459fd5`) |
| 6 | `feature/p6-ai-digital-twin` | AI logistics brain and advanced digital twin | **Merged** (PR #11, `72a2a0f`, 2026-10-27; first vertical slice) |
| 6.1 | `feature/p6-1-evaluation-worker` | Twin evaluation off the main thread (worker pool) | **Merged** (PR #12, `dd1d1a7`, 2026-11-01) |
| 6.2 | `feature/p6-2-multi-seed-evaluation` | Multi-seed robustness validation with paired statistics | **Merged** (PR #13, `61c67d5`, 2026-11-01; statistical corrections PR #14, `2117d38`, and PR #15, `6b1794b`, 2026-11-02; complete) |
| 7 | `feature/p7-production` | Production & portfolio release | **Started**: 7.0 audit complete; 7.1.1 dependency security merged (PR #17, `ea4ebd7`, CI 6/6); next 7.1.2 security-hardening audit |

## Phase 7 — Production & portfolio release (in progress)

The production track is deliberately audit-first. Do not start broad feature work or implement
security changes from assumptions; record evidence, review findings, then create focused PRs.

| Slice | Scope | State |
|---|---|---|
| 7.0 | Production-readiness audit | **Complete**; report delivered |
| 7.1.1 | Dependency security: Next.js/Zod fixes, pnpm and pip audits in CI, Dependabot configuration | **Merged** (PR #17, `ea4ebd7`; CI run 41571508901, 6/6 jobs passed) |
| 7.1.2 | Security-hardening audit: identity/authentication and authorization boundaries, API, secrets, persistence/data platform, browser/workers, AI integration and CI/CD supply chain | **Next**; audit only, no implementation until findings are triaged |
| 7.2 | Observability & reliability | Planned after security findings are triaged |
| 7.3 | Deployment & release | Planned |
| 7.4 | Demo & portfolio | Planned |

Dependabot follow-up is separate from the security audit: PRs #18 and #19 duplicate dependency
versions already merged by #17 and should be closed after confirming their diffs contain no extra
changes. Review PRs #20–#28 individually; major-version upgrades and grouped updates must pass
compatibility checks before merge. Never merge the queue wholesale.

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

## Phase 4 — Operations analytics (merged)

The refresh DAG publishes each reconciled gold build as an immutable snapshot; a read-only API
serves it with freshness and pipeline health; the Analytics mode shows run KPIs, simulated-time
series, task, order, pallet and transfer breakdowns and data quality, and labels stale, degraded and
missing data. Metrics catalogue, evidence and limitations: `docs/phases/PHASE_4.md`.

## Phase 5 — Multi-site logistics world (merged)

The DC inside a connected logistics park: container terminal, cross-dock, fleet depot and highway
gateway on a road network, with line-haul trucks carrying deterministic inter-site transfers that
hand over to the DC simulation. World and facility views, site and truck inspectors, operator
transfer requests. Record, results and next increments: `docs/phases/PHASE_5.md`.

## Phase 6 — AI and digital twin (first slice, 6.1 and 6.2 merged)

Fleet decision support: where idle line-haul trucks wait between jobs. A deterministic optimiser
simulates candidate standby plans with the engine itself, from a frozen snapshot of the live run,
and compares them with the plan in effect; proposals are re-validated by the API, approved by a
person, applied once through the operator command path and audited; AI explanations are optional,
server-side and policy-checked. Phase 6.1 runs the evaluations on a bounded pool of browser workers
(about 2× faster, no main-thread long tasks, identical results). Phase 6.2 validates a plan on
several seeded futures with paired statistics and an advisory verdict. Record, results and
limitations:
`docs/phases/PHASE_6.md`.

## Phase 3 — Real data engineering (merged)

PostgreSQL event store and transactional outbox behind an ingestion API, Kafka (KRaft), idempotent
consumers with a DLQ, Parquet bronze on S3-compatible storage, dbt silver/gold, Airflow refresh,
backfill and reconciliation, and an end-to-end smoke test. Plan, evidence and limitations:
`docs/phases/PHASE_3.md`.

## Phases 2–7

Summarised from the master brief. Detailed plans are written at the start of each phase in
`docs/phases/PHASE_<N>.md`.

- **2:** orders, pallets, forklifts with grid/graph pathfinding, workers, trucks and docks; save/load;
  invariants and replay tests for every new aggregate; Build and Operate modes.
- **3:** event log and outbox in PostgreSQL, Kafka (KRaft), idempotent consumers with DLQ, MinIO
  Parquet bronze, dbt silver and gold with tests, Airflow for backfill and reconciliation,
  recovery and duplicate tests.
- **4 (as delivered):** see above. Next there: utilisation and dock occupancy, cross-run
  comparison, alerts on stale or degraded analytics.
- **5 (as delivered):** multi-site world, see above. Next increments there: cross-site orders,
  a second detailed facility, traffic rules, network analytics.
- **6 (first slice as delivered):** see above. Next there: more strategies on the same pipeline
  (consolidation, depot-return policy, slotting), multi-seed evaluation with confidence intervals,
  time travel and replay UI, capacity planning, stress tests. (Evaluation workers: Phase 6.1.)
- **7:** polish, security review, observability, deployment, documentation, demo and
  commercialisation assessment.
