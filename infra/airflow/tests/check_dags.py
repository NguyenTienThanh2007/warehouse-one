"""DAG validation, run with the Airflow image's interpreter:

    docker compose --profile data run --rm --no-deps --entrypoint python airflow \
        /opt/airflow/dag_tests/check_dags.py

Checks that every DAG imports without errors and has the expected tasks, dependencies, retries,
timeouts and pools, and that every task calls a tool that exists in the image. Exits non-zero
on the first failure.
"""

import os
import re
import sys
from datetime import timedelta

try:  # Airflow 3.1+
    from airflow.dag_processing.dagbag import DagBag
except ImportError:  # pragma: no cover - older layout
    from airflow.models.dagbag import DagBag  # type: ignore[no-redef]

EXPECTED = {
    "warehouse_lake_refresh": {
        "edges": {
            ("pipeline_health", "dbt_build"),
            ("dbt_build", "bronze_freshness"),
            ("dbt_build", "reconcile"),
            ("reconcile", "publish_analytics"),
        },
        "schedule": "*/30 * * * *",
    },
    "warehouse_lake_backfill": {
        "edges": {
            ("validate_range", "rebuild_bronze"),
            ("rebuild_bronze", "dbt_build"),
            ("dbt_build", "reconcile"),
            ("reconcile", "publish_analytics"),
        },
        "schedule": None,
    },
    "warehouse_reconciliation": {"edges": set(), "schedule": "15 * * * *"},
}


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    sys.exit(1)


def main() -> None:
    folder = os.environ.get("DAG_FOLDER", "/opt/airflow/dags")
    # Airflow puts the DAGs folder on sys.path when it parses DAGs (shared warehouse_common).
    sys.path.insert(0, folder)
    bag = DagBag(dag_folder=folder)
    if bag.import_errors:
        fail(f"import errors: {bag.import_errors}")
    if set(bag.dag_ids) != set(EXPECTED):
        fail(f"DAGs {sorted(bag.dag_ids)} != {sorted(EXPECTED)}")
    for dag_id, spec in EXPECTED.items():
        dag = bag.dags[dag_id]
        edges = {(t.task_id, d) for t in dag.tasks for d in t.downstream_task_ids}
        if edges != spec["edges"]:
            fail(f"{dag_id}: edges {sorted(edges)} != {sorted(spec['edges'])}")
        if dag.schedule != spec["schedule"]:
            fail(f"{dag_id}: schedule {dag.schedule!r} != {spec['schedule']!r}")
        if dag.catchup or dag.max_active_runs != 1:
            fail(f"{dag_id}: catchup must be off and max_active_runs 1")
        for task in dag.tasks:
            timeout = task.execution_timeout
            if timeout is None or timeout > timedelta(hours=1):
                fail(f"{dag_id}.{task.task_id}: bounded execution_timeout required")
            command = getattr(task, "bash_command", "")
            for tool in re.findall(r"/opt/venvs/\w+/bin/[\w-]+", command):
                if not os.access(tool, os.X_OK):
                    fail(f"{dag_id}.{task.task_id}: {tool} is not executable in this image")
            # publish_analytics reads gold, so it must not run while a rebuild rewrites it.
            writes_lake = task.task_id in {
                "dbt_build",
                "rebuild_bronze",
                "reconcile",
                "publish_analytics",
            }
            if writes_lake and task.pool != "lake":
                fail(f"{dag_id}.{task.task_id}: lake writers must use the 'lake' pool")
        if dag.get_task("reconcile").retries != 0:
            fail(f"{dag_id}.reconcile: violations must not be retried away")
    print(f"OK: {len(EXPECTED)} DAGs, {sum(len(bag.dags[d].tasks) for d in EXPECTED)} tasks")


if __name__ == "__main__":
    main()
