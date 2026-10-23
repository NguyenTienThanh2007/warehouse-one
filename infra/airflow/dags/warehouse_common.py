"""Shared settings for the WAREHOUSE ONE DAGs (DEC-030).

Tasks call the warehouse-pipeline and dbt CLIs from their own virtual environments by absolute
path. Connection settings (PostgreSQL, Kafka, S3) come from the container environment (WAREHOUSE_*),
which BashOperator passes through; nothing secret is stored in Airflow.
"""

from datetime import timedelta

from airflow.providers.standard.operators.bash import BashOperator

PIPELINE = "/opt/venvs/pipeline/bin/warehouse-pipeline"
DBT = "/opt/venvs/dbt/bin/dbt"
DBT_DIRS = "--project-dir /opt/analytics --profiles-dir /opt/analytics"
# One writer of lake-derived outputs at a time (created at startup: airflow pools set lake 1).
LAKE_POOL = "lake"
# dbt's disposable DuckDB file and target dir, one per DAG run (runs never share a DuckDB file).
DBT_WORK = "/opt/airflow/dbt-work"
RUN_SLUG = "{{ run_id | replace(':', '_') }}"

DEFAULT_ARGS = {
    "owner": "data-platform",
    "retries": 2,
    "retry_delay": timedelta(seconds=30),
    "retry_exponential_backoff": True,
    "max_retry_delay": timedelta(minutes=5),
}


def pipeline_health() -> BashOperator:
    """Fail unless the relay and both consumers have a fresh `ok` heartbeat."""
    checks = " && ".join(
        f"{PIPELINE} health {component} --max-age 60"
        for component in ("relay", "consumer-ledger", "consumer-bronze")
    )
    return BashOperator(
        task_id="pipeline_health",
        bash_command=checks,
        retries=3,
        retry_delay=timedelta(seconds=20),
        execution_timeout=timedelta(minutes=2),
    )


def dbt_build() -> BashOperator:
    """Build and test silver and gold from bronze (full refresh; idempotent)."""
    return BashOperator(
        task_id="dbt_build",
        bash_command=f"{DBT} build {DBT_DIRS} --target-path {DBT_WORK}/{RUN_SLUG}",
        env={"DBT_DUCKDB_PATH": f"{DBT_WORK}/{RUN_SLUG}.duckdb"},
        append_env=True,
        pool=LAKE_POOL,
        retries=1,
        execution_timeout=timedelta(minutes=20),
    )


def reconcile(extra_args: str = "") -> BashOperator:
    """Run the reconciliation; exit 1 (task failure) on any violated invariant.

    `params.settle_s`: only events published at least this long ago are compared (they had time
    to reach every consumer); a manual run can pass 0 after checking the consumers caught up.
    """
    return BashOperator(
        task_id="reconcile",
        bash_command=(
            f"{PIPELINE} reconcile --settle {{{{ params.settle_s }}}} {extra_args} "
            "--triggered-by 'airflow:{{ dag.dag_id }}:{{ run_id }}'"
        ),
        pool=LAKE_POOL,
        # A violation is a finding, not a transient error: do not retry it away.
        retries=0,
        execution_timeout=timedelta(minutes=10),
    )


def publish_analytics() -> BashOperator:
    """Publish the reconciled gold build as an analytics snapshot (Phase 4, DEC-036). Runs only
    after the reconciliation task succeeded; the publisher re-checks that this run's report
    passed after this gold build and refuses otherwise."""
    return BashOperator(
        task_id="publish_analytics",
        # Cleared by this run's own reconciliation, not whichever report is newest: a scheduled
        # reconciliation of another DAG can finish in between.
        bash_command=(
            f"{PIPELINE} publish-analytics "
            "--triggered-by 'airflow:{{ dag.dag_id }}:{{ run_id }}' "
            "--cleared-by 'airflow:{{ dag.dag_id }}:{{ run_id }}'"
        ),
        pool=LAKE_POOL,
        retries=1,
        execution_timeout=timedelta(minutes=10),
    )
