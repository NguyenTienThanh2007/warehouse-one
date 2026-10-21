# Phase 4 — Advanced Operations Analytics

**Branch:** `feature/p4-analytics` · **Base:** `main` @ `0b25fa4` (Phase 3 merged; main CI green)
**Status:** PLANNING. No Phase 4 implementation or acceptance result is claimed by this document.

## 1. Goal

Turn the verified Phase 3 event pipeline and dbt gold marts into a trustworthy analytics experience.
An operator should be able to answer what happened, how operations performed, whether the numbers
are reconciled, and how fresh the data is—without mistaking historical analytics for the live
simulation state.

## 2. Scope

### A. Metrics catalogue

Create `docs/data/METRICS_CATALOG.md`. Every dashboard KPI must specify:

- business meaning and formula;
- grain and dimensions (run, simulated business date, event type, and future site/facility scope);
- unit, null/empty behaviour, and time basis;
- authoritative source model and event types;
- reconciliation or invariant test;
- freshness semantics and known limitations.

Initial metrics: event volume, orders shipped/cancelled, order lead time, tasks completed, task wait
and service time, inventory movements, pallet flows, duplicate deliveries, rejected events and
reconciliation status. Do not label an event-derived proxy as physical equipment/worker utilisation
unless the event contract can support that claim.

### B. Read-only analytics API

Proposed endpoints (final names may be adjusted to match repository conventions):

- `GET /api/v1/analytics/overview`
- `GET /api/v1/analytics/throughput`
- `GET /api/v1/analytics/orders`
- `GET /api/v1/analytics/tasks`
- `GET /api/v1/analytics/inventory`
- `GET /api/v1/analytics/health`

Use validated query parameters for date range and simulation filters. Return typed responses and
consistent error envelopes. Every analytics response must include a publication timestamp
(`as_of`) and snapshot/version identifier. The API must only serve a successfully published,
reconciled analytics snapshot; do not read arbitrary mutable Parquet files from the browser.

Before implementation, decide and document the serving strategy: versioned Parquet plus a manifest,
or a query-serving database/table. Avoid silently mixing models refreshed at different times.
Do not assume DuckDB is installed in the API image: it currently belongs to the pipeline optional
dependency group.

### C. Analytics dashboard

Add an Analytics view consistent with the existing WAREHOUSE ONE design system:

- **Overview:** event throughput, shipped/cancelled orders, lead time and task completion.
- **Orders & tasks:** lifecycle and duration distributions, with explicit sample counts.
- **Inventory & flow:** inventory movements and pallet transitions.
- **Data quality:** duplicate deliveries, rejected events and last reconciliation result.
- **Filters:** simulation/run and available date range; do not present unsupported site filters until
  the event/data model can represent sites.
- **States:** loading, no recorded data, stale snapshot, degraded pipeline and query error.

The current live KPI bar remains sourced from authoritative simulation state. Historical analytics
must be visibly labelled and must not silently replace live state.

### D. Freshness and pipeline health

Represent these as separate signals:

1. API/database liveness and readiness;
2. relay and consumer heartbeat/lag;
3. latest ingested event time;
4. latest successful dbt publication time;
5. latest reconciliation result and time.

Use explicit thresholds and explain the threshold in the UI. Quiet periods with no recorded runs
must not automatically be called pipeline failures; distinguish "no recent input" from "processing
is stuck". A healthy API alone must never imply that analytics is fresh.

### E. Tests and evidence

- API unit/integration tests for response schema, filters, errors and snapshot consistency.
- Metric-level tests against dbt gold fixtures.
- Reconciliation tests that compare API outputs with the exact published gold snapshot.
- Browser E2E for filters, loading/empty/error/stale states and accessible labels.
- Phase 0–3 regression checks and deterministic simulation golden fixture remain unchanged.
- Record actual commands, results, screenshots and limitations in this file before merge.

## 3. Proposed milestones

| Milestone | Deliverable | Gate |
|---|---|---|
| A | Metrics catalogue + source mapping | Every KPI has a formula and source |
| B | Snapshot publication contract + read API | API only serves consistent, reconciled snapshots |
| C | Dashboard overview and drill-downs | UI values reconcile with gold models |
| D | Freshness, pipeline health and alerts | Injected stale/degraded states are detected and recover |
| E | Tests, evidence and documentation | All checks pass; no unverified KPI claims |

## 4. Explicit non-goals

- Do not rebuild the Phase 3 ingestion/Kafka/MinIO pipeline without a reproduced defect.
- Do not add AI recommendations in Phase 4.
- Do not claim multi-site/city-scale rendering exists yet.
- Do not expose the unauthenticated development data stack publicly.
- Do not make Phase 4 depend on a production cloud deployment.

## 5. Multi-site product direction

WAREHOUSE ONE's intended destination is broader than one warehouse: multiple warehouses, yards,
cross-docks and connected logistics areas forming a city-scale network. Phase 4 should keep metric
definitions and API contracts extensible, but it should not balloon into a 3D-world rewrite.

- **Phase 5 — Multi-site logistics world:** introduce explicit site/facility identity and hierarchy,
  a world/site overview, multiple warehouse and yard areas, inter-site roads/routes, and a first
  deterministic transfer flow between hubs. Extend event contracts, snapshots, tests and analytics
  dimensions without breaking existing single-warehouse scenarios.
- **Phase 6 — AI + city-scale digital twin:** expand the connected map and cross-site flows; add
  scenario branching, time travel/replay, capacity planning, and AI proposals/optimisers with
  explicit validation and approval.

This makes the first visible multi-area expansion a Phase 5 deliverable, immediately after Phase 4,
rather than leaving it as an unspecified future idea.

## 6. Acceptance checklist

- [x] Initial metrics catalogue and source mapping drafted in `docs/data/METRICS_CATALOG.md` (API reconciliation still pending).
- [ ] Every API result identifies its published snapshot and freshness.
- [ ] API values reconcile with the published dbt gold models.
- [ ] Live simulation KPIs and historical analytics are clearly distinguished.
- [ ] Dashboard handles no data, stale data, API failure and reconciliation failure.
- [ ] Pipeline health is not inferred from API liveness alone.
- [ ] E2E and integration tests cover filters and failure/recovery states.
- [ ] Phase 0–3 regression suite and golden fixture remain unchanged.
- [ ] CI is green on the reviewable PR.
- [ ] No performance or data-quality claim is published without evidence.
