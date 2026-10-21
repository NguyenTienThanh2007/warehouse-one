"""Reconciliation against real PostgreSQL, Kafka and S3: a consistent pipeline passes, and every
deliberately injected discrepancy is reported (and the repair path clears it).
"""

from datetime import date
from typing import Any

import pytest
from sqlalchemy import Engine, delete, select

from tests.integration.conftest import RunFixture
from tests.integration.test_consumers import consume_until, lake_settings, publish_run
from warehouse_api.store.tables import (
    bronze_objects,
    consumer_events,
    reconciliation_reports,
)
from warehouse_pipeline.bronze import BronzeProcessor, rebuild_from_postgres
from warehouse_pipeline.consumer import ConsumerService
from warehouse_pipeline.lake import delete_object, ensure_bucket, filesystem, list_objects
from warehouse_pipeline.ledger import LedgerProcessor
from warehouse_pipeline.reconcile import Report, Scope, reconcile
from warehouse_pipeline.settings import PipelineSettings

pytestmark = [pytest.mark.integration, pytest.mark.kafka]

NOW = Scope(settle_s=0, require_models=False, triggered_by="test")


@pytest.fixture
def pipeline(engine: Engine, ops_demo: RunFixture) -> PipelineSettings:
    """A run stored, relayed and fully consumed by the ledger and bronze consumers."""
    settings = lake_settings()
    ensure_bucket(settings)
    publish_run(engine, settings, ops_demo)
    for processor in (LedgerProcessor(), BronzeProcessor(settings)):
        service = ConsumerService(engine, settings, processor, instance=f"r-{processor.group}")
        service.subscribe()
        try:
            consume_until(service, len(ops_demo.events))
        finally:
            service.close()
    return settings


def checks(report: Report) -> dict[str, int]:
    return {v["check"]: v["count"] for v in report.violations}


def test_a_consistent_pipeline_reconciles(
    engine: Engine, pipeline: PipelineSettings, ops_demo: RunFixture
) -> None:
    report = reconcile(engine, pipeline, NOW)
    assert report.status == "passed", report.violations
    n = len(ops_demo.events)
    assert report.metrics["source_settled_events"] == n
    assert report.metrics["ledger_events"] == n
    assert report.metrics["bronze_distinct_events"] == n
    assert report.metrics["models_built"] is False  # not required in this test
    # The report is stored durably and in the lake.
    with engine.connect() as conn:
        row = conn.execute(select(reconciliation_reports)).mappings().one()
    assert row["status"] == "passed" and row["report_object_key"] == report.object_key
    assert filesystem(pipeline).get_file_info(f"{pipeline.lake_bucket}/{report.object_key}").size


def test_a_lost_bronze_object_is_detected_and_repaired_from_postgres(
    engine: Engine, pipeline: PipelineSettings, ops_demo: RunFixture
) -> None:
    lost_key = sorted(list_objects(pipeline))[0]
    delete_object(pipeline, lost_key)
    report = reconcile(engine, pipeline, NOW)
    found = checks(report)
    assert report.status == "failed"
    assert found["missing_in_bronze"] > 0
    assert found["manifest_objects_missing_from_store"] == 1

    day = date.fromisoformat(ops_demo.events[0]["occurred_at"][:10])
    repair = rebuild_from_postgres(engine, pipeline, day, day)
    assert repair.pruned_manifest_keys == [lost_key]
    after = reconcile(engine, pipeline, NOW)
    assert after.status == "passed", after.violations
    # Rebuilt copies sit next to the Kafka copies: auditable, deduplicated by event_id later.
    assert after.metrics["bronze_redelivered_copies"] > 0


def test_a_lost_ledger_record_is_detected(engine: Engine, pipeline: PipelineSettings) -> None:
    with engine.begin() as conn:
        victim = conn.execute(select(consumer_events.c.event_id).limit(1)).scalar_one()
        conn.execute(delete(consumer_events).where(consumer_events.c.event_id == victim))
    report = reconcile(engine, pipeline, NOW)
    assert report.status == "failed"
    violation = next(v for v in report.violations if v["check"] == "missing_in_ledger")
    assert violation["count"] == 1 and violation["detail"] == [str(victim)]


def test_untracked_objects_and_unsettled_scope_are_reported(
    engine: Engine, pipeline: PipelineSettings
) -> None:
    with engine.begin() as conn:
        key = conn.execute(select(bronze_objects.c.object_key).limit(1)).scalar_one()
        conn.execute(delete(bronze_objects).where(bronze_objects.c.object_key == key))
    assert checks(reconcile(engine, pipeline, NOW))["bronze_objects_not_in_manifest"] == 1

    # Nothing has had a day to settle: no comparison is claimed, and that is not a pass.
    waiting: Any = reconcile(engine, pipeline, Scope(settle_s=86_400, require_models=False))
    assert waiting.metrics["source_settled_events"] == 0
    assert waiting.status in {"not_settled", "failed"}


def test_models_are_required_unless_skipped(engine: Engine, pipeline: PipelineSettings) -> None:
    report = reconcile(engine, pipeline, Scope(settle_s=0, require_models=True))
    assert checks(report).get("models_not_built") == 1
