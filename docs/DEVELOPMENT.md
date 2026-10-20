# Development Guide

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24.x (`.nvmrc`) | |
| pnpm | 11.25.0 (`packageManager` field) | `corepack enable` installs the pinned version |
| Python | 3.12 (`.python-version`) | Managed by uv |
| uv | 0.12.x | https://docs.astral.sh/uv/ |
| Docker + Compose v2 | Docker 29 / Compose 5 tested | For PostgreSQL and the API container |

## First run

```bash
pnpm install                          # TS workspace (allows only esbuild's install script)
(cd apps/api && uv sync)              # Python env from uv.lock
cp .env.example .env                  # optional local overrides
docker compose up -d --build --wait   # postgres + migrate + api on :5432 / :8000
pnpm dev                              # web on http://localhost:3000
```

If ports are taken, override them: `POSTGRES_PORT=5442 API_PORT=8010 docker compose up -d --wait`,
then `NEXT_PUBLIC_API_URL=http://localhost:8010 pnpm --filter @warehouse-one/web dev -p 3100`. When the web app runs on a
port other than 3000, also allow it in the API's CORS list, for example:
`WAREHOUSE_CORS_ORIGINS='["http://localhost:3100"]'`.

## Everyday commands

| Task | Command |
|------|---------|
| All TS quality gates | `pnpm check` (format, lint, typecheck, test, build) |
| TS unit tests | `pnpm test` |
| Typecheck | `pnpm typecheck` |
| Lint / format | `pnpm lint`, `pnpm format` |
| Browser e2e | `pnpm --filter @warehouse-one/web build && pnpm test:e2e` (`WEB_PORT=3100` by default) |
| API checks | `cd apps/api && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest` |
| API integration | `cd apps/api && WAREHOUSE_DATABASE_URL=postgresql+psycopg://warehouse:warehouse_dev@localhost:5432/warehouse_one uv run pytest -m integration` |
| Migrations | `cd apps/api && uv run alembic upgrade head` |
| Regenerate JSON Schemas | `pnpm schemas:generate` (required after changing `packages/contracts`) |
| Regenerate golden fixture | `pnpm fixtures:generate` (only for an *intended* engine behaviour change; explain why in the commit) |
| Benchmarks | `pnpm bench:sim`, `pnpm bench:render` (see `docs/architecture/PERFORMANCE.md`) |
| Visual bookmarks | `pnpm capture:bookmarks` (needs `next start -p 3100`) → `docs/phases/evidence/phase-1/` |
| Scenario / quality | open `/?scenario=bench-1000&quality=low` (scenarios: showcase, empty, bench-100/300/1000) |

## Conventions

- **Commits:** Conventional Commits (`feat(scope): …`, `fix`, `docs`, `test`, `chore`).
- **Branches:** `feature/p<N>-<topic>`. Nothing merges to `main` without passing CI and owner approval.
- **TypeScript:** strict, with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. No
  `Math.random`, `Date.now` or `new Date()` in `packages/simulation/src` (lint-enforced).
- **Python:** ruff (incl. bandit rules) and mypy `--strict` on `src`.
- **Contracts:** change Zod → `pnpm schemas:generate` → update the Pydantic mirror → tests must pass.
- **Secrets:** never in code, fixtures or `NEXT_PUBLIC_*`. Only `.env.example` is committed.

## Troubleshooting

- **`ERR_PNPM_IGNORED_BUILDS`:** a new dependency wants an install script. Review it, then add it
  to `allowBuilds` in `pnpm-workspace.yaml` only if needed.
- **Golden test fails after an engine change:** expected if behaviour changed intentionally.
  Regenerate fixtures and review the diff in `data/fixtures/foundation-demo/summary.json`.
- **FPS ~1 in the HUD:** the tab or pane is hidden and the browser is throttling rAF. Measure with
  `pnpm bench:render` instead.
