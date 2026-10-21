# syntax=docker/dockerfile:1.7
# Build context: repository root. Airflow 3 with two isolated tool environments (DEC-030):
#   /opt/venvs/pipeline  warehouse-pipeline CLI (apps/api with the pipeline extra)
#   /opt/venvs/dbt       dbt-duckdb project (analytics/)
# Airflow's own dependencies never mix with them; DAG tasks call the CLIs.
FROM ghcr.io/astral-sh/uv:0.12.21 AS uv

FROM apache/airflow:3.3.2-python3.12
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1
USER root
RUN mkdir -p /opt/venvs /opt/build /opt/airflow/dbt-work \
 && chown -R airflow:root /opt/venvs /opt/build /opt/airflow/dbt-work
USER airflow

COPY --chown=airflow:root apps/api/pyproject.toml apps/api/uv.lock apps/api/README.md /opt/build/api/
COPY --chown=airflow:root apps/api/src /opt/build/api/src
RUN cd /opt/build/api && UV_PROJECT_ENVIRONMENT=/opt/venvs/pipeline \
    uv sync --locked --no-dev --extra pipeline --no-editable --python /usr/python/bin/python3.12

COPY --chown=airflow:root analytics/pyproject.toml analytics/uv.lock /opt/analytics/
RUN cd /opt/analytics && UV_PROJECT_ENVIRONMENT=/opt/venvs/dbt \
    uv sync --locked --python /usr/python/bin/python3.12
COPY --chown=airflow:root analytics/dbt_project.yml analytics/profiles.yml /opt/analytics/
COPY --chown=airflow:root analytics/models /opt/analytics/models
COPY --chown=airflow:root analytics/macros /opt/analytics/macros
COPY --chown=airflow:root analytics/tests /opt/analytics/tests

# DuckDB's S3 support is an extension: install it at build time for both environments.
RUN /opt/venvs/dbt/bin/python -c "import duckdb; duckdb.connect().execute('INSTALL httpfs')" \
 && /opt/venvs/pipeline/bin/python -c "import duckdb; duckdb.connect().execute('INSTALL httpfs')"

COPY --chown=airflow:root infra/airflow/dags /opt/airflow/dags
COPY --chown=airflow:root infra/airflow/tests /opt/airflow/dag_tests
# The tool environments are deliberately not on PATH (their `python` must not shadow Airflow's);
# DAGs call /opt/venvs/<tool>/bin/<cli> by absolute path.
