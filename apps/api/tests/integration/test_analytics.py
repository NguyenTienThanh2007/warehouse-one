"""Analytics snapshots against a real PostgreSQL (Phase 4): the publication rule, every API state,
window filters, totals that reconcile with the published rows, pinning and pruning, and that the
API is read-only. Gold comes from tests/analytics_gold.py (hand-computed); the end-to-end proof
with a dbt build of a recorded run is the data-platform smoke test."""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, insert, select, update

from tests.analytics_gold import EPOCH, EVENTS, INGESTED, RUN, write_gold
from tests.integration.conftest import RunFixture
from tests.integration.kafka_support import store_run
from warehouse_api.api import analytics as analytics_api
from warehouse_api.store.tables import (
    analytics_snapshots,
    analytics_task_facts,
    heartbeats,
    reconciliation_reports,
)
from warehouse_pipeline import analytics
from warehouse_pipeline.analytics import PublishRefusedError, local_gold, publish

pytestmark = pytest.mark.integration

URL = "/api/v1/analytics"
MIN = 60_000


def gold(tmp_path: Path, built_at: datetime | None = None) -> analytics.GoldSource:
    write_gold(tmp_path)
    return local_gold(tmp_path, built_at or datetime.now(UTC) - timedelta(minutes=5))


def report(
    engine: Engine, status: str, *, models: bool = True, ago: float = 0, by: str = "test"
) -> uuid.UUID:
    rid = uuid.uuid4()
    finished = datetime.now(UTC) - timedelta(seconds=ago)
    with engine.begin() as conn:
        conn.execute(
            insert(reconciliation_reports).values(
                report_id=rid,
                status=status,
                scope={},
                metrics={"models_built": models},
                violations=[],
                triggered_by=by,
                started_at=finished,
                finished_at=finished,
            )
        )
    return rid


def healthy_components(engine: Engine) -> None:
    with engine.begin() as conn:
        for c in ("relay", "consumer-ledger", "consumer-bronze"):
            conn.execute(
                insert(heartbeats).values(component=c, instance="i1", status="ok", details={})
            )


def published(engine: Engine, tmp_path: Path) -> uuid.UUID:
    report(engine, "passed")
    return publish(engine, gold(tmp_path), triggered_by="test").snapshot_id


def run_url(**params: Any) -> tuple[str, dict[str, Any]]:
    return f"{URL}/runs/{RUN}", params


def iso(ms: int) -> str:
    return (EPOCH + timedelta(milliseconds=ms)).isoformat().replace("+00:00", "Z")


@pytest.fixture
def published_run(engine: Engine, tmp_path: Path) -> None:
    published(engine, tmp_path)


class TestPublication:
    def test_nothing_published_is_an_empty_state_not_an_error(self, client: TestClient) -> None:
        body = client.get(f"{URL}/status").json()
        assert body["state"] == "empty"
        assert body["snapshot"] is None
        assert "no reconciliation has run yet" in body["pipeline"]["problems"]
        assert client.get(f"{URL}/runs").json()["error"]["code"] == "NO_SNAPSHOT"

    @pytest.mark.parametrize(
        "case",
        [
            (None, True, 0, "no reconciliation report"),
            ("failed", True, 0, "is failed"),
            ("passed", False, 0, "did not check the silver/gold models"),
            ("passed", True, 3600, "older than the gold build"),
        ],
    )
    def test_only_a_reconciliation_that_passed_after_the_build_clears_it(
        self, engine: Engine, tmp_path: Path, case: tuple[str | None, bool, float, str]
    ) -> None:
        status, models, ago, reason = case
        if status:
            report(engine, status, models=models, ago=ago)
        with pytest.raises(PublishRefusedError, match=reason):
            publish(engine, gold(tmp_path), triggered_by="test")
        with engine.connect() as conn:
            assert conn.execute(select(func.count()).select_from(analytics_snapshots)).scalar() == 0

    def test_a_dag_run_is_cleared_by_its_own_reconciliation_not_a_newer_one(
        self, engine: Engine, tmp_path: Path
    ) -> None:
        mine = report(engine, "passed", ago=10, by="airflow:refresh:run-1")
        report(engine, "failed", by="airflow:warehouse_reconciliation:scheduled")
        with pytest.raises(PublishRefusedError, match="is failed"):
            publish(engine, gold(tmp_path), triggered_by="t")
        result = publish(
            engine, gold(tmp_path), triggered_by="t", cleared_by="airflow:refresh:run-1"
        )
        assert result.reconciliation_report_id == mine
        with pytest.raises(PublishRefusedError, match="by airflow:refresh:other"):
            publish(engine, gold(tmp_path), triggered_by="t", cleared_by="airflow:refresh:other")

    def test_a_snapshot_records_its_lineage(
        self, engine: Engine, tmp_path: Path, client: TestClient
    ) -> None:
        rid = report(engine, "passed")
        built = datetime.now(UTC) - timedelta(minutes=5)
        result = publish(engine, gold(tmp_path, built), triggered_by="test")
        assert (result.runs, result.source_events, result.reconciliation_report_id) == (
            1,
            EVENTS,
            rid,
        )
        snap = client.get(f"{URL}/status").json()["snapshot"]
        assert snap["reconciliation_status"] == "passed"
        assert snap["reconciliation_report_id"] == str(rid)
        assert snap["source_events"] == EVENTS
        assert snap["source_watermark"].startswith(INGESTED.isoformat()[:19])
        assert snap["business_from"].startswith("2026-01-05T06:00:00")
        assert snap["business_to"].startswith("2026-01-05T06:30:00")
        assert snap["time_basis"] == "simulated"


class TestRunAnalytics:
    def test_whole_run_totals_equal_the_gold_rows(
        self, engine: Engine, tmp_path: Path, client: TestClient
    ) -> None:
        published(engine, tmp_path)
        runs = client.get(f"{URL}/runs").json()["runs"]
        assert [(r["simulation_id"], r["events"], r["redelivered_copies"]) for r in runs] == [
            (RUN, EVENTS, 2)
        ]
        url, params = run_url()
        a = client.get(url, params=params).json()
        k = a["kpis"]
        assert k["events"] == EVENTS == sum(p["events"] for p in a["series"])
        assert (k["tasks_created"], k["tasks_completed"], k["tasks_cancelled"]) == (4, 2, 1)
        # Cycle times: t1 300 s, t2 1380 s → median 840 s, p90 1272 s (linear interpolation).
        assert (k["task_cycle_p50_ms"], k["task_cycle_p90_ms"]) == (840_000, 1_272_000)
        # Waits (assigned - created): t1 60 s, t2 60 s, t3 100 s → median 60 s.
        assert k["task_wait_p50_ms"] == 60_000
        assert (k["orders_opened"], k["orders_shipped"], k["orders_open_at_end"]) == (2, 1, 1)
        assert k["order_lead_p50_ms"] == 1_640_000
        assert (k["pallets_created"], k["pallets_received"], k["pallets_shipped"]) == (2, 2, 4)
        assert (k["transfers_delivered"], k["transfer_pallets_delivered"]) == (2, 15)
        assert k["transfer_lead_p50_ms"] == (1_500_000 + 650_000) // 2
        assert a["window"]["resolution_ms"] == MIN and a["window"]["buckets"] == 31
        assert {(t["task_type"], t["completed"]) for t in a["tasks_by_type"]} == {
            ("pick", 1),
            ("putaway", 0),
            ("relocate", 1),
        }
        assert [(lane["lane_id"], lane["pallets"]) for lane in a["transfers_by_lane"]] == [
            ("lane-a", 10),
            ("operator request", 5),
        ]
        assert {(f["flow"], f["detail"], f["pallets"]) for f in a["pallet_flows"]} == {
            ("created", "receive", 1),
            ("created", "inbound_truck", 1),
            ("moved", "slot>equipment", 1),
            ("removed", "shipped", 4),
        }
        assert a["integrity"] == {"events": EVENTS, "missing_sequences": 0, "redelivered_copies": 2}

    def test_a_window_counts_only_what_happened_inside_it_half_open(
        self, engine: Engine, tmp_path: Path, client: TestClient
    ) -> None:
        published(engine, tmp_path)
        url, _ = run_url()
        a = client.get(url, params={"from": iso(10 * MIN), "to": iso(20 * MIN)}).json()
        k = a["kpis"]
        # Created in [10, 20) min: t3 (600 s) and t4 (900 s); cancelled: t4; nothing completed.
        assert (k["tasks_created"], k["tasks_completed"], k["tasks_cancelled"]) == (2, 0, 1)
        assert k["task_cycle_p50_ms"] is None
        # o2 opens at exactly 20 min: outside a window that ends at 20 min.
        assert (k["orders_opened"], k["orders_open_at_end"]) == (0, 1)
        assert k["events"] == 4 == sum(p["events"] for p in a["series"])
        assert a["window"]["from_ms"] == 10 * MIN and a["window"]["to_ms"] == 20 * MIN
        assert len(a["series"]) == 10
        assert a["series"][0]["bucket_start"].startswith("2026-01-05T06:10:00")

    def test_kpis_reconcile_with_the_published_rows(
        self, engine: Engine, tmp_path: Path, client: TestClient
    ) -> None:
        sid = published(engine, tmp_path)
        url, _ = run_url()
        for lo, hi in [(0, 5), (0, 31), (5, 26), (25, 31)]:
            k = client.get(url, params={"from": iso(lo * MIN), "to": iso(hi * MIN)}).json()["kpis"]
            with engine.connect() as conn:
                completed = conn.execute(
                    select(func.count()).where(
                        analytics_task_facts.c.snapshot_id == sid,
                        analytics_task_facts.c.completed_ms >= lo * MIN,
                        analytics_task_facts.c.completed_ms < hi * MIN,
                    )
                ).scalar()
            assert k["tasks_completed"] == completed, (lo, hi)

    @pytest.mark.parametrize(
        ("params", "code"),
        [
            ({"from": "2026-01-05T06:20:00Z", "to": "2026-01-05T06:10:00Z"}, "INVALID_WINDOW"),
            ({"from": "2026-01-06T00:00:00Z"}, "INVALID_WINDOW"),  # after the run's end
            (
                {"from": "2026-01-06T00:00:00Z", "to": "2026-01-06T01:00:00Z"},
                "WINDOW_OUT_OF_RANGE",
            ),
            ({"from": "2025-12-01T00:00:00Z", "to": "2026-01-05T06:30:00Z"}, "WINDOW_TOO_LARGE"),
        ],
    )
    def test_bad_windows_are_rejected(
        self, published_run: None, client: TestClient, params: dict[str, str], code: str
    ) -> None:
        url, _ = run_url()
        r = client.get(url, params=params)
        assert (r.status_code, r.json()["error"]["code"]) == (422, code)

    def test_unknown_runs_and_snapshots_are_404(
        self, engine: Engine, tmp_path: Path, client: TestClient
    ) -> None:
        published(engine, tmp_path)
        r = client.get(f"{URL}/runs/{uuid.uuid4()}")
        assert (r.status_code, r.json()["error"]["code"]) == (404, "RUN_NOT_IN_SNAPSHOT")
        r = client.get(f"{URL}/runs", params={"snapshot_id": str(uuid.uuid4())})
        assert (r.status_code, r.json()["error"]["code"]) == (404, "SNAPSHOT_NOT_FOUND")


class TestFreshnessAndHealth:
    def test_fresh_needs_a_healthy_pipeline_and_a_recent_snapshot(
        self, engine: Engine, tmp_path: Path, client: TestClient
    ) -> None:
        published(engine, tmp_path)
        assert client.get(f"{URL}/status").json()["state"] == "degraded"  # no heartbeats yet
        healthy_components(engine)
        body = client.get(f"{URL}/status").json()
        assert body["state"] == "fresh", body["pipeline"]["problems"]
        assert body["freshness"]["is_stale"] is False
        with engine.begin() as conn:
            conn.execute(
                update(analytics_snapshots).values(
                    generated_at=datetime.now(UTC) - timedelta(hours=3)
                )
            )
        body = client.get(f"{URL}/status").json()
        assert (body["state"], body["freshness"]["is_stale"]) == ("stale", True)

    def test_a_failed_reconciliation_after_publication_degrades_it(
        self, engine: Engine, tmp_path: Path, client: TestClient
    ) -> None:
        published(engine, tmp_path)
        healthy_components(engine)
        rid = report(engine, "failed")
        body = client.get(f"{URL}/status").json()
        assert body["state"] == "degraded"
        assert body["pipeline"]["reconciliation"]["report_id"] == str(rid)
        assert f"latest reconciliation failed (report {rid})" in body["pipeline"]["problems"]
        # The last good snapshot stays available, labelled by the state above.
        assert body["snapshot"] is not None

    def test_events_recorded_after_the_snapshot_are_counted(
        self, engine: Engine, tmp_path: Path, client: TestClient, ops_demo: RunFixture
    ) -> None:
        published(engine, tmp_path)
        before = client.get(f"{URL}/status").json()["freshness"]["events_recorded_after"]
        assert before == 0  # the watermark (12:00 today) predates nothing yet stored
        store_run(engine, ops_demo, "t")
        after = client.get(f"{URL}/status").json()["freshness"]
        assert after["events_recorded_after"] == len(ops_demo.events)
        assert after["latest_event_recorded_at"] is not None

    def test_stale_or_unhealthy_components_are_named(
        self, engine: Engine, tmp_path: Path, client: TestClient
    ) -> None:
        published(engine, tmp_path)
        healthy_components(engine)
        with engine.begin() as conn:
            conn.execute(
                update(heartbeats)
                .where(heartbeats.c.component == "relay")
                .values(last_beat_at=datetime.now(UTC) - timedelta(minutes=10))
            )
        body = client.get(f"{URL}/status").json()
        assert body["state"] == "degraded"
        assert "relay has no healthy instance" in body["pipeline"]["problems"]


class TestSnapshots:
    def test_latest_is_served_older_ones_can_be_pinned_and_old_ones_are_pruned(
        self, engine: Engine, tmp_path: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        first = published(engine, tmp_path)
        second = published(engine, tmp_path)
        assert client.get(f"{URL}/runs").json()["snapshot_id"] == str(second)
        assert client.get(f"{URL}/runs", params={"snapshot_id": str(first)}).json()[
            "snapshot_id"
        ] == str(first)
        monkeypatch.setattr(analytics, "KEEP_SNAPSHOTS", 2)
        third = published(engine, tmp_path)
        with engine.connect() as conn:
            kept = set(conn.execute(select(analytics_snapshots.c.snapshot_id)).scalars())
        assert third in kept and len(kept) == 2

    def test_republishing_the_same_gold_gives_identical_figures(
        self, engine: Engine, tmp_path: Path, client: TestClient
    ) -> None:
        a = published(engine, tmp_path)
        b = published(engine, tmp_path)
        url, _ = run_url()
        one = client.get(url, params={"snapshot_id": str(a)}).json()
        two = client.get(url, params={"snapshot_id": str(b)}).json()
        for body in (one, two):
            body.pop("snapshot_id")
            body.pop("generated_at")
        assert one == two


def test_the_analytics_api_is_read_only(client: TestClient) -> None:
    mine = [r for r in analytics_api.router.routes if isinstance(r, APIRoute)]
    assert {r.path for r in mine} == {
        f"{URL}/status",
        f"{URL}/runs",
        f"{URL}/runs/{{simulation_id}}",
    }
    assert all(r.methods == {"GET"} for r in mine)
    assert client.post(f"{URL}/status").status_code == 405
