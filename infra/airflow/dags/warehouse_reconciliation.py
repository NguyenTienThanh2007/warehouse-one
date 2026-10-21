"""Standalone reconciliation (hourly and on demand): report every mismatch between PostgreSQL,
the ledger, bronze and the dbt outputs; fail when an invariant is violated."""

from datetime import timedelta

import pendulum
from airflow.sdk import DAG, Param
from warehouse_common import DEFAULT_ARGS, reconcile

with DAG(
    dag_id="warehouse_reconciliation",
    description="Reconcile source, consumers, lake and models; fail on violations.",
    schedule="15 * * * *",
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
    dagrun_timeout=timedelta(minutes=20),
    tags=["warehouse-one", "reconciliation"],
) as dag:
    reconcile()
