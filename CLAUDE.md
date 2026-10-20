# CLAUDE.md — WAREHOUSE ONE

3D warehouse digital twin + deterministic simulation + real data engineering platform. The master
brief governs scope; phases are in `docs/ROADMAP.md`.

## Current state

- **Active phase:** 0 (Foundation), in review on `feature/p0-foundation`. **Do not start Phase 1
  until the owner approves Phase 0.**
- Status and evidence: `docs/PROJECT_STATUS.md`, `docs/phases/PHASE_0.md`.

## Architecture (one screen)

- `packages/simulation`: **operational source of truth.** Pure `step(config, state, commands)`,
  fixed 100 ms tick, seeded RNG kept in state, versioned snapshots, replay. The runner is the only
  imperative shell and publishes deep-frozen state.
- `packages/contracts`: Zod schemas for commands and events → `data/schemas/*.json` (generated).
- `apps/web`: Next.js 16 + R3F. Zustand is a *read-only projection* of the runner. Rendering never writes state.
- `apps/api`: FastAPI + SQLAlchemy + Alembic + PostgreSQL. Pydantic mirror of the event contract.
- Details: `docs/ARCHITECTURE.md`, `docs/data/EVENT_CONTRACT.md`, `docs/DECISIONS.md`.

## Commands

```bash
pnpm install && (cd apps/api && uv sync)
pnpm check                                   # format, lint, typecheck, test, build (TS)
pnpm test:e2e                                # Playwright, needs `pnpm --filter @warehouse-one/web build`
cd apps/api && uv run ruff check . && uv run mypy && uv run pytest [-m integration]
docker compose up -d --build --wait          # postgres + migrate + api
pnpm schemas:generate / pnpm fixtures:generate / pnpm bench:sim / pnpm bench:render
```

## Invariants (tested; never weaken a test to make it pass)

1. Same config + seed + command log ⇒ identical state hash and events (replay, golden fixture).
2. Inventory is never negative or fractional; locations never exceed capacity.
3. Invalid commands are rejected with a code, never thrown, never partially applied.
4. Same-tick commands apply sequentially, so conflicts are rejected, not double-applied.
5. Pause freezes simulated time; tick count depends only on total elapsed time × speed.
6. `step()` never mutates its input; published state is frozen.
7. Event `sequence` is gap-free, `aggregate_version` is +1 per aggregate, and `event_id` is deterministic.
8. Snapshots load only if version, hash and invariants check out.

## Conventions

- No `Math.random`, `Date.now` or `new Date()` in `packages/simulation/src` (ESLint enforces it).
- After a contract change, run `pnpm schemas:generate` and update `apps/api/.../contracts/events.py`.
- Regenerate golden fixtures only for intended behaviour changes, and say so in the commit.
- Conventional Commits; phase branches; never merge to `main` without owner approval.
- Report checks as PASS / FAIL / BLOCKED / NOT RUN / NOT APPLICABLE. Never claim unexecuted results.
- Create directories and packages only when real code needs them (DEC-007).

## Known blockers / gotchas

- Local ports 3000/8000/5432 may be taken on the dev machine; use `WEB_PORT`, `API_PORT`, `POSTGRES_PORT`.
- Hidden browser panes throttle rAF, so FPS from them is meaningless. Use `pnpm bench:render`.
- TypeScript is pinned to 6.0 and ESLint to 9 (DEC-008).
