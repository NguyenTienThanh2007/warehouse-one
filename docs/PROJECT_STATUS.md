# Project Status

_Last updated: 2026-10-21_

| Item | State |
|------|-------|
| Active phase | **Phase 4: Advanced operations analytics**, planned on `feature/p4-analytics` |
| `main` | `0b25fa4`: Phases 0–3 merged; Phase 3 main CI run 39560402887 succeeded |
| Last merged phase | Phase 3, Real data engineering (PR #5, merged 2026-10-21) |

## Phase 3 at merge (verified)

- PR #5 merged to `main` as `0b25fa4`: [PR #5](https://github.com/NguyenTienThanh2007/warehouse-one/pull/5).
- Main CI on the merge commit passed: [run 39560402887](https://github.com/NguyenTienThanh2007/warehouse-one/actions/runs/39560402887).
- The Phase 3 verification record in `docs/phases/PHASE_3.md` documents:
  - `pnpm check`, Python checks and integration suites passing;
  - dbt build 68/68 and Airflow validation for 3 DAGs / 9 tasks;
  - end-to-end data-platform smoke test: 18 checks passed, including Kafka/MinIO outages,
    replay/duplicate delivery, restart recovery, discrepancy detection and backfill repair.
- These are local integration results plus a separate green CI run; they are not a production
  deployment or a throughput benchmark.

## Phase 4 — Advanced operations analytics

The initial scope is defined in `docs/phases/PHASE_4.md`. It will add a metrics catalogue,
read-only analytics API, dashboard backed by published dbt gold snapshots, and truthful
freshness/pipeline-health indicators. It must not treat stale historical marts as live simulation.

## Multi-site / city-scale world

The current 3D scene represents one warehouse facility. The project goal includes multiple
warehouses and connected logistics areas, not just one building. The proposed sequence is:

- **Phase 4:** make analytics contracts and UI ready to distinguish live simulation from
  historical data; do not expand the 3D world in this phase.
- **Phase 5:** introduce the spatial/network foundation and first visible multi-site slice:
  multiple facilities/areas, a site overview, and explicit connections between hubs.
- **Phase 6:** expand toward a city-scale digital twin with cross-site logistics flows, scenario
  comparison, replay/time travel and capacity planning.

See `docs/ROADMAP.md` for the phase sequence.

## Known limitations and owner decisions

- Phase 3 infrastructure remains development-only: single Kafka broker, no service authentication
  or TLS, and no public exposure before security work.
- Analytics freshness must be reported independently of API liveness.
- Repository licence and public-demo hosting remain Phase 7 decisions.
- Local development ports 3000 and 8000 may be occupied; documented overrides are in
  `docs/DEVELOPMENT.md`.

Details: [Roadmap](ROADMAP.md) · [Phase 3](phases/PHASE_3.md) · [Phase 4](phases/PHASE_4.md).
