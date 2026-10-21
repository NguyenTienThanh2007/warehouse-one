# syntax=docker/dockerfile:1.7
# Build context: apps/api
#
# Targets:
#   api       FastAPI service and migrations (default; no data-platform dependencies)
#   pipeline  outbox relay, Kafka consumers, bronze writer, reconciliation (warehouse-pipeline CLI)
FROM ghcr.io/astral-sh/uv:0.12.21 AS uv

FROM python:3.12.14-slim-trixie AS build-base
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./

FROM build-base AS build-api
# Dependencies first for layer caching; the lockfile makes the install reproducible.
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project
COPY src ./src
COPY migrations ./migrations
COPY alembic.ini ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev

FROM build-base AS build-pipeline
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --extra pipeline --no-install-project
COPY src ./src
COPY migrations ./migrations
COPY alembic.ini ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --extra pipeline

FROM python:3.12.14-slim-trixie AS runtime-base
RUN groupadd --system app && useradd --system --gid app --home /app app \
 && mkdir -p /app && chown app:app /app
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

FROM runtime-base AS pipeline
COPY --from=build-pipeline --chown=app:app /app /app
USER app
# DuckDB's S3 support is an extension: install it at build time, not on first use.
RUN python -c "import duckdb; duckdb.connect().execute('INSTALL httpfs')"
# Each service sets its own command and health check (see docker-compose.yml).
CMD ["warehouse-pipeline", "--help"]

FROM runtime-base AS api
COPY --from=build-api --chown=app:app /app /app
USER app
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else 1)"]
CMD ["uvicorn", "warehouse_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
