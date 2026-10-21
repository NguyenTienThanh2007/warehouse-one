"""Routine processing: check the streaming pipeline, build silver/gold, reconcile."""

from datetime import timedelta

import pendulum
from airflow.providers.standard.operators.bash import BashOperator
from airflow.sdk import DAG, Param
from warehouse_common import (
    DBT,
    DBT_DIRS,
    DBT_WORK,
    DEFAULT_ARGS,
    dbt_build,
    pipeline_health,
    reconcile,
)

with DAG(
    dag_id="warehouse_lake_refresh",
    description="Bronze → silver/gold with dbt, then reconcile against PostgreSQL.",
    schedule="*/30 * * * *",
    start_date=pendulum.datetime(2026, 10, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    default_args=DEFAULT_ARGS,
    params={
        "settle_s": Param(
            60,
            type="integer",
            minimum=0,
            description="Reconcile events published at least this many seconds ago",
        )
    },
    dagrun_timeout=timedelta(minutes=45),
    tags=["warehouse-one", "lake"],
) as dag:
    health = pipeline_health()
    build = dbt_build()
    freshness = BashOperator(
        task_id="bronze_freshness",
        # Warn-only thresholds (models/sources.yml): reports staleness without failing the run.
        bash_command=f"{DBT} source freshness {DBT_DIRS} --target-path {DBT_WORK}/freshness",
        env={"DBT_DUCKDB_PATH": f"{DBT_WORK}/freshness.duckdb"},
        append_env=True,
        retries=0,
        execution_timeout=timedelta(minutes=5),
    )
    check = reconcile()
    health >> build >> [freshness, check]
