# WAREHOUSE ONE — Product Requirements Document

**Tagline:** Intelligent Logistics. Living Data.
**Status:** v1.0 draft, written in Phase 0. Revised at the start of each phase.

## 1. Problem

Warehouse operators, logistics students and analytics teams lack an environment where they can
*see* a facility operate, change it, and measure the effect with trustworthy data. Existing tools
are either static dashboards (data without a model of the operation) or game-like simulations
(operation without reliable data). WAREHOUSE ONE joins both: a deterministic simulation of a
warehouse, rendered in 3D, whose every state change is an auditable event flowing into a real
analytics pipeline.

## 2. Goals

| # | Goal | Measured by |
|---|------|-------------|
| G1 | Credible, deterministic warehouse simulation | Replay tests: same seed + commands ⇒ identical state hash and events |
| G2 | Premium, readable 3D environment in the browser | Captured screenshots reviewed against `docs/design/VISUAL_DESIGN_SPEC.md`; measured FPS |
| G3 | Real data engineering, not a mock | Events flow simulation → outbox → Kafka → lake → dbt with tests for duplicates, replay, freshness |
| G4 | Analytics users can trust | Dashboard values reconcile with source events; live vs. delayed data labelled |
| G5 | AI that is useful and safe | Structured, validated proposals; no mutation without explicit approval; benchmarked against baselines |
| G6 | Portfolio-grade engineering | CI green, reproducible setup, every claim backed by evidence in `docs/phases/` |

### Non-goals (for now)

- Multi-tenant SaaS, billing, authentication beyond a single local user (assessed in Phase 7).
- Integration with real WMS/ERP systems.
- Physically accurate vehicle dynamics; motion is kinematic and rule-based.
- Mobile-first editing. Phones get a read-only, responsive view.

## 3. Users

1. **Portfolio reviewer / hiring engineer.** Wants a quick demo, then evidence of engineering depth
   (tests, data pipeline, decisions). Needs it to run on first try and a README that is honest.
2. **Operations analyst (persona).** Watches throughput and bottlenecks, compares scenarios, needs
   numbers that reconcile and are clearly labelled as live or historical.
3. **Warehouse planner (persona).** Designs layouts, asks "what if we add three forklifts?", needs
   valid layouts and comparable simulated outcomes.

## 4. Product modes

| Mode | Purpose | Key requirements | Phase |
|------|---------|------------------|-------|
| Explore | Navigate and inspect the facility | Orbit/pan/zoom, follow vehicle, select and inspect any entity; all values from authoritative state | 1 |
| Build | Design layouts | Place/move/remove racks, docks, zones and routes; collision and validity preview; undo/redo; save/restore | 2 |
| Operate | Run the operation | Start/pause/speed; inbound shipments and outbound orders; resource assignment; deterministic, auditable transitions | 2 |
| Analytics | Understand performance | Orders, cycle time, utilisation, throughput, delays, queues, bottlenecks; freshness indicators | 4 |
| AI | Get recommendations | Natural-language questions ⇒ inspectable, validated proposals; approval before any change | 5 |

## 5. Functional requirements (summary)

**Simulation (source of truth).** Fixed-step, seeded and deterministic. Typed commands are
validated and may be rejected. Typed domain events are emitted for every state change. Snapshots
are versioned. Core invariants (no negative stock, capacity respected, one pallet in one place,
pause freezes time, replay equality) are enforced and tested.

**Data platform.** A durable event log with a transactional outbox feeds Kafka. Consumers are
idempotent, with retry, a dead-letter queue and replay/backfill. A Parquet lake on MinIO feeds dbt
models in bronze, silver and gold layers, with data-quality tests, freshness checks and
reconciliation reports.

**Analytics.** Metrics listed in the master brief (orders received/completed, processing time,
inventory accuracy, utilisation of space/forklifts/workers, throughput/hour, delays, route
distance, queue lengths, bottlenecks), each with a definition in the metrics catalogue (Phase 4).

**AI.** A provider-agnostic service (Claude and/or Gemini) produces structured JSON validated
against schemas. Deterministic optimisers produce the numbers. Proposals are simulated before
being presented, and the user approves each one.

## 6. Quality requirements

- **Performance:** target 60 FPS on an Apple Silicon laptop for standard scenes, with defined
  fallbacks. Benchmark scenes at 100, 300 and 1,000 entities. All figures measured, never estimated.
- **Reliability:** idempotent ingestion, no silent data loss, observable failures.
- **Security:** no secrets in the frontend or the repo, validated inputs at every trust boundary,
  prompt-injection-aware AI design.
- **Accessibility:** keyboard operable HUD, visible focus, WCAG AA contrast for text, reduced
  motion respected.

## 7. Success criteria for the portfolio release (Phase 7)

- Fresh clone to running demo in under 15 minutes using only documented commands.
- CI green on `main` (typecheck, lint, unit, integration, e2e, build).
- A 3-minute demo walkthrough covering all five modes.
- Every performance or KPI claim in the README links to recorded evidence.

## 8. Open questions

- Hosting target for the public demo (static web + managed Postgres vs. a single VM). Decide in Phase 7.
- Licence for the repository (affects commercial plans). **Owner: project owner.**
- AI provider budget limits for the public demo (Phase 5).
