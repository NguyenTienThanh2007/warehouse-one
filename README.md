# WAREHOUSE ONE

**Intelligent Logistics. Living Data.**

A browser-based 3D warehouse digital twin built on a deterministic simulation engine, with a real
data engineering pipeline and AI-assisted optimisation planned on top. Every number on screen comes
from authoritative simulation state, and every state change is a typed, replayable domain event.

> **Project status: Phase 0 (Foundation) is complete and awaiting review.** The 3D scene below is a
> *diagnostic* view that proves the simulation → rendering path. The production 3D world is Phase 1.
> See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for what is verified and what is not.

![Phase 0 foundation: live simulation driving an instanced diagnostic scene with HUD](docs/phases/evidence/phase-0-desktop-1440x900.png)

## What exists today

- **Deterministic simulation engine** (`packages/simulation`). Pure fixed-step `step()`, seeded
  RNG stored in state, typed commands with safe rejection, deterministic event IDs, versioned and
  integrity-checked snapshots, replay from a command log. A test suite covers the core invariants:
  determinism, replay equality, no negative stock, capacity, same-tick conflicts, unit
  conservation under a 3,000-tick randomised command stream, and pause freezing time.
- **Versioned event contract** (`packages/contracts`). Zod schemas published as JSON Schema
  (`data/schemas`) and mirrored in Pydantic, with drift tests on both sides and a golden
  deterministic run (`data/fixtures`) that Python reconciles against the engine's own totals.
- **Web app** (`apps/web`). Next.js 16, React Three Fiber, Tailwind 4. A live in-browser simulation,
  an instanced scene, location selection with an inspector, simulation controls and keyboard
  shortcuts, API health and an FPS/p95 probe.
- **API** (`apps/api`). FastAPI with structured JSON logs, request IDs, liveness/readiness/version
  endpoints, SQLAlchemy and Alembic on PostgreSQL 18, and a Dockerfile.
- **Quality gates.** ESLint/Prettier/tsc, Vitest, pytest (unit and integration), ruff, mypy
  `--strict`, Playwright e2e and a GitHub Actions CI with Docker Compose verification.

## Architecture

```text
commands ─► Simulation (pure, deterministic) ─► domain events ─► [Phase 3] outbox ─► Kafka ─► Parquet lake ─► dbt ─► analytics & AI
                 │ frozen state
                 ▼
     Zustand projection ─► React Three Fiber scene + HUD   (rendering is read-only)
```

Read more: [Architecture](docs/ARCHITECTURE.md) · [Event contract](docs/data/EVENT_CONTRACT.md) ·
[Decisions](docs/DECISIONS.md) · [Visual design spec](docs/design/VISUAL_DESIGN_SPEC.md) ·
[Performance](docs/architecture/PERFORMANCE.md) · [PRD](docs/product/PRD.md) · [Roadmap](docs/ROADMAP.md)

## Quick start

Requires Node 24, pnpm 11, Python 3.12 with [uv](https://docs.astral.sh/uv/), and Docker.

```bash
pnpm install && (cd apps/api && uv sync)
docker compose up -d --build --wait    # PostgreSQL + migrations + API on :8000
pnpm dev                               # http://localhost:3000
```

Controls: drag to orbit, scroll to zoom, right-drag to pan, click a location to inspect it.
`Space` pauses or resumes, `.` steps one tick, `1`–`5` set the speed, `Esc` clears the selection.
More detail, including port overrides, is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Verification

```bash
pnpm check                      # format, lint, typecheck, unit tests, production build
pnpm test:e2e                   # browser tests against the production build
cd apps/api && uv run pytest && uv run pytest -m integration
pnpm bench:sim                  # simulation throughput
```

Measured Phase 0 results are recorded with their hardware context in
[docs/architecture/PERFORMANCE.md](docs/architecture/PERFORMANCE.md) and
[docs/phases/PHASE_0.md](docs/phases/PHASE_0.md).

## Roadmap

0 Foundation · 1 Premium 3D world · 2 Living simulation · 3 Data engineering (Kafka, MinIO/Parquet,
dbt, Airflow) · 4 Analytics · 5 AI logistics brain · 6 Digital twin scenarios · 7 Production release.

## Licence

Not yet chosen. All rights reserved until a licence is added.
