# Development Guide

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24.x (`.nvmrc`) | |
| pnpm | 11.25.0 (`packageManager` field) | `corepack enable` installs the pinned version |
| Python | 3.12 (`.python-version`) | Managed by uv |
| uv | 0.12.x | https://docs.astral.sh/uv/ |
| Docker + Compose v2 | Docker 29 / Compose 5 tested | PostgreSQL and the API; the data profile needs ~2 GB free memory |

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

## Data platform (Phase 3)

The default `docker compose up` is unchanged. The full pipeline is the `data` profile:

```bash
docker compose --profile data up -d --build --wait   # first build of the Airflow image takes ~10 min
pnpm sim:record --api http://localhost:8000 --scenario showcase --ticks 3000
pnpm sim:verify --api http://localhost:8000 --simulation <simulation_id from the line above>
scripts/data-platform-smoke.sh                         # end-to-end proof, ~4 min, exits 1 on failure
```

| Service | Default port | What it is |
|---------|--------------|------------|
| api | 8000 | ingestion API (`/api/v1/simulations`) |
| kafka | 9094 (host listener) | Kafka 4.2.2, KRaft, single broker (dev only) |
| minio | 9000 (S3), 9001 (console) | pinned `bitnamilegacy/minio`; user `warehouse` / `warehouse_dev_minio` (dev defaults) |
| airflow | 8080 | Airflow 3.3.2 standalone; no login (dev only) |
| relay, consumer-ledger, consumer-bronze | — | `warehouse-pipeline` processes; health = fresh heartbeat |

Override ports with `API_PORT`, `KAFKA_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`, `AIRFLOW_PORT`,
`POSTGRES_PORT` (in `.env` or the environment). Override credentials with `POSTGRES_PASSWORD`,
`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`.

| Task | Command |
|------|---------|
| Record from the browser | Build or run the web app with `NEXT_PUBLIC_API_URL` set, then **Record run** in the status panel (restarts the scenario as a new run) |
| A run's counts in every layer | `docker compose exec relay warehouse-pipeline status --simulation <id>` |
| Re-publish a run (safe) | `docker compose exec relay warehouse-pipeline replay --simulation <id>` |
| Rebuild bronze for a date range | `docker compose exec relay warehouse-pipeline bronze-rebuild --start 2026-01-05 --end 2026-01-05` |
| Reconcile | `docker compose exec relay warehouse-pipeline reconcile [--start D --end D] [--settle 60]` (exit 1 on violations) |
| Component health | `docker compose exec relay warehouse-pipeline health relay` (or `consumer-ledger`, `consumer-bronze`) |
| dbt by hand | `cd analytics && uv sync && WAREHOUSE_S3_ENDPOINT=localhost:9000 WAREHOUSE_S3_ACCESS_KEY=warehouse WAREHOUSE_S3_SECRET_KEY=warehouse_dev_minio uv run dbt build --profiles-dir .` |
| Query the lake | DuckDB with `httpfs`: `SELECT * FROM read_parquet('s3://warehouse-lake/gold/simulation_activity.parquet')` (set `s3_endpoint`, `s3_url_style='path'`, `s3_use_ssl=false` and the keys); readers outside dbt must skip all-NULL placeholder rows of empty models |
| Trigger DAGs | UI on :8080, or `docker compose exec airflow airflow dags trigger warehouse_lake_refresh --conf '{"settle_s": 0}'` (DAGs are paused at creation; a paused DAG's run stays queued) |
| Backfill a date range | `airflow dags trigger warehouse_lake_backfill --conf '{"start_date": "2026-01-05", "end_date": "2026-01-05"}'` |
| Publish analytics by hand | `docker compose exec relay warehouse-pipeline publish-analytics` (refuses unless the latest reconciliation passed after the gold build; the refresh DAG does this every 30 min) |
| Analytics API | `curl localhost:8000/api/v1/analytics/status`, `/runs`, `/runs/<id>?from=…&to=…` (simulated time, ISO 8601 with Z) |
| Analytics in the browser | `/?mode=analytics` (needs the API with a published snapshot; otherwise the page explains the state) |
| Validate DAGs | `docker compose --profile data run --rm --no-deps --entrypoint python airflow /opt/airflow/dag_tests/check_dags.py` |
| Python tests with Kafka/S3 | start `postgres kafka minio` only, then in `apps/api`: `uv sync --all-extras && WAREHOUSE_KAFKA_BOOTSTRAP_SERVERS=localhost:9094 WAREHOUSE_S3_ENDPOINT=localhost:9000 WAREHOUSE_S3_ACCESS_KEY=warehouse WAREHOUSE_S3_SECRET_KEY=warehouse_dev_minio uv run pytest -m kafka` (these tests **truncate** the operations and pipeline tables: never point them at data you want to keep) |
| Stop | `docker compose --profile data down` (keeps volumes) |
| Reset all local data | `docker compose --profile data down -v` (**deletes** PostgreSQL, Kafka, MinIO and Airflow volumes: every recorded run and the whole lake) |

## Everyday commands

| Task | Command |
|------|---------|
| All TS quality gates | `pnpm check` (format, lint, typecheck, test, build) |
| TS unit tests | `pnpm test` |
| Typecheck | `pnpm typecheck` |
| Lint / format | `pnpm lint`, `pnpm format` |
| Browser e2e | `pnpm --filter @warehouse-one/web build && pnpm test:e2e` (`WEB_PORT=3100` by default) |
| API checks | `cd apps/api && uv sync --all-extras && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest` |
| API integration (PostgreSQL) | `cd apps/api && WAREHOUSE_DATABASE_URL=postgresql+psycopg://warehouse:warehouse_dev@localhost:5432/warehouse_one uv run pytest -m "integration and not kafka"` (truncates the operations and pipeline tables) |
| Migrations | `cd apps/api && uv run alembic upgrade head` |
| Regenerate JSON Schemas | `pnpm schemas:generate` (required after changing `packages/contracts`) |
| Regenerate golden fixture | `pnpm fixtures:generate` (only for an *intended* engine behaviour change; explain why in the commit) |
| Benchmarks | `pnpm bench:sim`, `pnpm bench:render` (see `docs/architecture/PERFORMANCE.md`) |
| Visual bookmarks | `pnpm capture:bookmarks` (needs `next start -p 3100`) → `docs/phases/evidence/phase-1/` |
| Multi-site captures | `pnpm capture:network` (needs `next start -p 3100`) → `docs/phases/evidence/phase-5/` |
| Scenario / quality | open `/?scenario=bench-1000&quality=low` (scenarios: network (default), showcase, empty, bench-100/300/1000) |

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
- **A pipeline service is `unhealthy`:** look at its heartbeat:
  `docker compose exec relay warehouse-pipeline health relay`. `"kafka": "unreachable"` means the
  broker is down; the outbox keeps the events and the relay retries with backoff.
- **Bronze is behind:** `warehouse-pipeline status --simulation <id>` shows `lake_error` while the
  object store is unreachable; the consumer retries and rewinds (no dead letters for outages).
- **Reconciliation `failed`:** the JSON report lists each violated check with up to 20 example
  `event_id`s (stored in `pipeline.reconciliation_reports` and
  `s3://warehouse-lake/reports/reconciliation/`).
  - A lost bronze object is repaired by the backfill DAG for its date.
  - Dead letters need a person to look at them: they never clear automatically.
- **`uv run pytest` fails with `ModuleNotFoundError` on macOS:** the `.venv` `.pth` files got the
  `hidden` flag (`chflags -R nohidden apps/api/.venv`).
