# warehouse-api

FastAPI backend for WAREHOUSE ONE. See the repository root `README.md` and `docs/ARCHITECTURE.md`.

```bash
uv sync                      # install (Python 3.12, pinned via uv.lock)
uv run uvicorn warehouse_api.main:app --reload --port 8000
uv run pytest                # unit + contract tests
uv run pytest -m integration # requires PostgreSQL (docker compose up -d postgres)
uv run ruff check . && uv run ruff format --check . && uv run mypy
uv run alembic upgrade head
```
