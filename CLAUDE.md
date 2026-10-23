# CLAUDE.md — WAREHOUSE ONE

3D warehouse digital twin + deterministic simulation + real data engineering platform. The master
brief governs scope; phases are in `docs/ROADMAP.md`.

## Current state

- **Active phase:** 4 (Operations analytics) on `feature/p4-analytics-refresh`. Phases 0–3 and 5 are
  merged (PR #7), plus the top-bar modes fix (PR #8).
- Status and evidence: `docs/PROJECT_STATUS.md`, `docs/phases/PHASE_4.md`.

## Architecture (one screen)

- `packages/simulation`: **operational source of truth.** Pure `step(config, state, commands)`,
  fixed 100 ms tick, seeded RNG kept in state, versioned snapshots, replay. The runner is the only
  imperative shell and publishes deep-frozen state.
- `packages/simulation/src/network`: the logistics network around the facility (optional
  `config.network` / `state.network`, DEC-032–035). The DC is never modelled twice: line-haul
  trucks hand over through the DC's command handlers. Default scenario `network`; single site is
  `?scenario=showcase`.
- Analytics (Phase 4, DEC-036–038): gold → `warehouse-pipeline publish-analytics` (only after a
  passed reconciliation) → `analytics.*` snapshots → `GET /api/v1/analytics/*` → Analytics mode.
  Business time is simulated; publication and health times are wall clock. Never mix them.
- `packages/contracts`: Zod schemas for commands and events → `data/schemas/*.json` (generated).
- `apps/web`: Next.js 16 + R3F. Zustand is a *read-only projection* of the runner. Rendering never writes state.
  `src/world/derive.ts` maps config + state to instances (pure, tested); `components/world/*` draws them.
  Facility geometry comes from `config.facility` (DEC-014). Never render entities that are not in config/state.
- `apps/api`: FastAPI + SQLAlchemy + Alembic + PostgreSQL. Pydantic mirror of the event contract.
- Details: `docs/ARCHITECTURE.md`, `docs/data/EVENT_CONTRACT.md`, `docs/DECISIONS.md`.

## Commands

```bash
pnpm install && (cd apps/api && uv sync)
pnpm check                                   # format, lint, typecheck, test, build (TS)
pnpm test:e2e                                # Playwright, needs `pnpm --filter @warehouse-one/web build`
cd apps/api && uv run ruff check . && uv run mypy && uv run pytest [-m integration]
docker compose up -d --build --wait          # postgres + migrate + api
pnpm schemas:generate / pnpm fixtures:generate / pnpm bench:sim / pnpm bench:render / pnpm capture:bookmarks
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
9. Network: stock never negative, allocations within stock, capacity counts incoming, a truck only
   leaves with a reserved stand, pallets are conserved across sites, trailers and the DC.

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
- Playwright uses the real GPU on macOS and SwiftShader in CI; the app starts on Low quality under software WebGL (DEC-017).
- Keep per-asset triangle budgets (`world/geometry.test.ts`); measure before and after any rendering change.
