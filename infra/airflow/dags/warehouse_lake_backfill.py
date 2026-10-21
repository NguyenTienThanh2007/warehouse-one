"""Backfill / reprocess a simulated date range: rebuild bronze from the PostgreSQL event log,
rebuild silver/gold, reconcile the range. Every step is idempotent (deterministic object keys,
full-refresh models), so the same range can be run again safely."""

from datetime import timedelta

import pendulum
from airflow.providers.standard.operators.bash import BashOperator
from airflow.sdk import DAG, Param
from warehouse_common import DEFAULT_ARGS, LAKE_POOL, PIPELINE, dbt_build, reconcile

RANGE = "--start {{ params.start_date }} --end {{ params.end_date }}"

with DAG(
    dag_id="warehouse_lake_backfill",
    description="Rebuild bronze for a date range from PostgreSQL, rebuild models, reconcile.",
    schedule=None,
    start_date=pendulum.datetime(2026, 10, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    default_args=DEFAULT_ARGS,
    dagrun_timeout=timedelta(hours=2),
    params={
        "start_date": Param(
            "2026-01-05",
            type="string",
            format="date",
            description="First simulated business date (UTC)",
        ),
        "settle_s": Param(
            60,
            type="integer",
            minimum=0,
            description="Reconcile events published at least this many seconds ago",
        ),
        "end_date": Param(
            "2026-01-05",
            type="string",
            format="date",
            description="Last simulated business date (UTC), inclusive",
        ),
    },
    tags=["warehouse-one", "lake", "backfill"],
) as dag:
    validate = BashOperator(
        task_id="validate_range",
        bash_command=(
            '[[ ! "{{ params.end_date }}" < "{{ params.start_date }}" ]] '
            '|| { echo "end_date is before start_date" >&2; exit 1; }'
        ),
        retries=0,
        execution_timeout=timedelta(minutes=1),
    )
    rebuild = BashOperator(
        task_id="rebuild_bronze",
        bash_command=f"{PIPELINE} bronze-rebuild {RANGE}",
        pool=LAKE_POOL,
        execution_timeout=timedelta(minutes=30),
    )
    build = dbt_build()
    check = reconcile(RANGE)
    validate >> rebuild >> build >> check
