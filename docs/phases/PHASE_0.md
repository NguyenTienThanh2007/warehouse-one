# Phase 0 — Foundation & Architecture

**Branch:** `feature/p0-foundation` · **PR:** https://github.com/NguyenTienThanh2007/warehouse-one/pull/1 (draft)
**Status:** ACCEPTED. Merged to `main` as `c512733` on 2026-10-20 after owner approval; CI green on the PR head and on `main`.

## 1. Starting state (inspected 2026-10-20)

- `origin/main` held one GitHub-generated commit (`be2bc1c`, 15-byte README). It was built on,
  not overwritten. The foundation commit `d319462` was fast-forwarded onto `main`.
- A local folder named `warehouse-one ` (trailing space, empty) also exists next to the clone. It
  was left untouched.
- A reference video exists at `~/Documents/references/` (outside the repo). It was inspected for
  the visual benchmark (see the visual spec, §7).
- Host: Apple M2, 8 GB, macOS 26.6.2, Node 24.16.0, pnpm 11.25.0, uv 0.12.21, Docker 29.6.1
  (~4 GB VM). Host ports 3000, 8000 and 5432 were occupied by unrelated processes, so
  verification used 3100, 8010 and 5442 through the documented overrides.

## 2. Plan → delivered

| Deliverable | Where | Status |
|-------------|-------|--------|
| Product requirements document | `docs/product/PRD.md` | Done |
| Technical architecture | `docs/ARCHITECTURE.md`, `docs/data/EVENT_CONTRACT.md`, `docs/DECISIONS.md` | Done |
| Monorepo scaffolding, dependency config | pnpm workspace, uv project, pinned versions (DEC-008) | Done |
| Docker development environment | `docker-compose.yml`, `apps/api/Dockerfile` | Done |
| Basic frontend application | `apps/web` | Done |
| Basic FastAPI application | `apps/api` | Done |
| Simulation engine foundation | `packages/simulation` | Done |
| Typed data contracts | `packages/contracts`, `data/schemas`, Pydantic mirror | Done |
| CI workflow | `.github/workflows/ci.yml` | Done; first run on PR #1 (§4) |
| Test infrastructure | Vitest, pytest (unit + integration marker), Playwright | Done |
| Visual design specification | `docs/design/VISUAL_DESIGN_SPEC.md`, tokens in `globals.css` | Done |
| Performance measurement approach | `docs/architecture/PERFORMANCE.md`, `bench:sim`, `bench:render`, in-app probe | Done |
| Development documentation | `README.md`, `CLAUDE.md`, `docs/DEVELOPMENT.md` | Done |

## 3. Acceptance criteria

| Criterion | Result | Evidence |
|-----------|--------|----------|
| Project installs successfully | **PASS** | Fresh clone of `c434e98` → `pnpm install --frozen-lockfile` exit 0; `uv sync --locked` exit 0 |
| Web application starts | **PASS** | `next start` serves `/` (HTTP 200); Playwright suite passes against it; screenshots below |
| API health endpoint works | **PASS** | Docker: `/health` 200, `/health/ready` 200 with `database: ok`, `/version` reports the git SHA; unit tests cover the 503 path |
| Simulation tests pass | **PASS** | 36/36 (determinism, replay, snapshots, invariants, fuzzing, golden fixture) |
| Typecheck passes | **PASS** | `pnpm typecheck` (3 packages + tests) exit 0; `mypy --strict` clean |
| Build passes | **PASS** | `next build` (Next 16.3.8, Turbopack) succeeds; Docker image builds |
| Required Docker services can start | **PASS** | `docker compose up -d --build --wait` exit 0: postgres healthy, migrate exited 0, api healthy |
| CI validated by an actual run | **PASS** | GitHub Actions run 39414680150 (PR head `7bcf7ed`): all 4 jobs green; run 39415222348 on `main` (`c512733`): all 4 jobs green. An earlier run (39414560916) was cancelled by the workflow's concurrency rule when `7bcf7ed` was pushed |
| Documentation matches implementation | **PASS** (self-review) | Paths, commands and numbers in docs were taken from the runs above |

## 4. Quality gates

| # | Gate | Result | Detail |
|---|------|--------|--------|
| 1 | TypeScript typecheck | PASS | `tsc` on contracts, simulation, web, tests |
| 2 | Lint | PASS | ESLint (`--max-warnings 0`), Prettier check, ruff, ruff format, actionlint 1.7.12 |
| 3 | Unit tests | PASS | TS: contracts 14, simulation 36, web 16 = **66**. Python: **20** |
| 4 | Integration tests | PASS | Python vs PostgreSQL 18.6: readiness, Alembic upgrade → downgrade → upgrade (**2**) |
| 5 | Browser e2e | PASS | Playwright Chromium vs production build: **5/5**. The first local run failed 2/5 because the API container had been restarted without the `:3100` CORS origin; that was an environment misconfiguration, the test caught it, and it passed after correcting the config |
| 6 | Production build | PASS | Next.js build; API Docker image |
| 7 | Regression | PASS | Golden-fixture byte-equality test; RNG output pinned by inline snapshot; schema drift tests |
| 8 | Security checks | PASS (scope-limited) | ruff `S` (bandit) rules; no secrets committed (`.env` ignored, dev-only defaults labelled); CORS allow-list; request-ID sanitisation tests; error details hidden in production; security headers on web. **No dependency vulnerability audit run yet** (planned for CI in Phase 1) |
| 9 | Performance checks | PASS (baseline recorded) | See `docs/architecture/PERFORMANCE.md`. Diagnostic scene ~60 FPS (vsync-capped), p95 18.6–21.2 ms at 24–1,000 locations on Apple M2 / ANGLE Metal |
| 10 | Documentation review | PASS (self-review) | Owner review pending |
| — | GitHub Actions CI | PASS | Runs 39414680150 and 39415222348: TypeScript, Python + PostgreSQL integration, Playwright e2e (SwiftShader), Docker Compose |

## 5. Evidence

- Screenshots (Playwright, production build, API online):
  `evidence/phase-0-desktop-1440x900.png` (inspector open on `loc-00-007`, whose contents match
  event #20 in the stream) and `evidence/phase-0-mobile-390x844.png` (no horizontal overflow, verified programmatically).
- Golden run: `data/fixtures/foundation-demo/summary.json`. 600 ticks, 150 events (89 received,
  60 moved, 1 adjusted), 3 scripted rejections with the expected codes, state hash `4d6546fae08b82a31c7dcc1062605b05`.
- Benchmarks: `docs/architecture/PERFORMANCE.md`.

## 6. Known limitations

1. The 3D scene is a **diagnostic placeholder** (instanced boxes on tiles), labelled as such in the UI. It is not the Phase 1 world.
2. Mobile camera framing shows only part of the layout. Responsive camera framing is in Phase 1 scope.
3. The simulation runs on the main thread in the browser. A Web Worker is evaluated in Phase 2 when entity systems exist.
4. When the browser throttles rAF (hidden tab), the 250 ms per-frame clamp means simulated time
   runs slower than real time. This is intentional: it prevents catch-up bursts.
5. Domain scope is inventory only (receive, move, adjust). Orders, vehicles, workers and trucks are Phase 2.
6. The API has no domain endpoints or persistence of simulation runs yet. Outbox and event log are Phase 3.
7. No dependency vulnerability scan (`pnpm audit`, `pip-audit`) wired into CI yet.
8. The visual comparison with the reference video is **unverified** by design (see the visual spec, §7).
9. No repository licence chosen (owner decision).
10. Render benchmarks run in headless Chromium. Headed-browser figures may differ slightly.

## 7. Handoff notes for Phase 1

- Start from `docs/design/VISUAL_DESIGN_SPEC.md` §4–§7. The acceptance checklist is in §7.
- Replace `apps/web/src/components/viewport/diagnostic-scene.tsx` with the real world. Keep the
  adapter rule: the scene reads `useSimulation` state and never writes it.
- The benchmark harness already supports layout sizes through `?aisles=&bays=`. Extend it to Phase 1
  camera bookmarks and add a draw-call budget assertion.
- Consider extracting `packages/graphics` (asset factories, materials) once a second consumer
  appears (DEC-007).
- Add `pnpm audit` / `pip-audit` jobs to CI.
