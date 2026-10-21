"""Analytics API tests against published snapshot rows in PostgreSQL."""

from datetime import UTC, datetime
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, insert

from warehouse_api.store.tables import (
    analytics_model_rows,
    analytics_snapshots,
    reconciliation_reports,
)

pytestmark = pytest.mark.integration


def test_overview_calculates_kpis_from_one_published_snapshot(
    client: TestClient, engine: Engine
) -> None:
    report_id = uuid.uuid4()
    snapshot_id = uuid.uuid4()
    simulation_id = uuid.uuid4()
    now = datetime.now(UTC)
    rows = [
        ("gold_simulation_activity", {"simulation_id": str(simulation_id), "events": 120}),
        (
            "gold_order_fulfilment",
            {
                "simulation_id": str(simulation_id),
                "order_id": "ord-1",
                "status": "shipped",
                "lead_time_ms": 3000,
            },
        ),
        (
            "gold_order_fulfilment",
            {
                "simulation_id": str(simulation_id),
                "order_id": "ord-2",
                "status": "cancelled",
                "lead_time_ms": None,
            },
        ),
        (
            "gold_task_lifecycle",
            {
                "simulation_id": str(simulation_id),
                "task_id": "task-1",
                "status": "completed",
                "wait_ms": 1000,
                "service_ms": 2000,
            },
        ),
        (
            "gold_task_lifecycle",
            {
                "simulation_id": str(simulation_id),
                "task_id": "task-2",
                "status": "pending",
                "wait_ms": None,
                "service_ms": None,
            },
        ),
        (
            "gold_inventory_movements",
            {"simulation_id": str(simulation_id), "quantity_change": 5},
        ),
        ("gold_pallet_flows", {"simulation_id": str(simulation_id), "flow": "moved"}),
        (
            "gold_event_volume_daily",
            {
                "event_date": "2026-10-20",
                "event_type": "task.completed",
                "events": 50,
                "simulations": 1,
                "redelivered_copies": 1,
            },
        ),
        (
            "gold_event_volume_daily",
            {
                "event_date": "2026-10-20",
                "event_type": "order.status_changed",
                "events": 70,
                "simulations": 1,
                "redelivered_copies": 0,
            },
        ),
        ("gold_data_quality", {"check_name": "conflicting_copies", "kind": "error", "value": 2}),
    ]
    with engine.begin() as conn:
        conn.execute(
            insert(reconciliation_reports).values(
                report_id=report_id,
                status="passed",
                scope={},
                metrics={},
                violations=[],
                triggered_by="test:analytics",
            )
        )
        conn.execute(
            insert(analytics_snapshots).values(
                snapshot_id=snapshot_id,
                source_as_of=now,
                reconciliation_report_id=report_id,
                reconciliation_status="passed",
                model_counts={},
            )
        )
        conn.execute(
            insert(analytics_model_rows),
            [
                {
                    "snapshot_id": snapshot_id,
                    "model_name": model_name,
                    "row_index": index,
                    "row_data": data,
                }
                for index, (model_name, data) in enumerate(rows)
            ],
        )

    response = client.get(
        "/api/v1/analytics/overview", params={"simulation_id": str(simulation_id)}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["snapshot_id"] == str(snapshot_id)
    assert body["freshness"] == "fresh"
    assert body["metrics"] == {
        "recorded_simulations": 1,
        "domain_events": 120,
        "orders_shipped": 1,
        "orders_cancelled": 1,
        "mean_order_lead_time_ms": 3000.0,
        "tasks_completed": 1,
        "mean_task_wait_ms": 1000.0,
        "mean_task_service_ms": 2000.0,
        "inventory_movement_rows": 1,
        "pallet_flow_events": 1,
        "data_quality_errors_global": 2,
    }
    assert body["sample_counts"] == {
        "order_lead_time": 1,
        "task_wait_time": 1,
        "task_service_time": 1,
    }

    throughput = client.get("/api/v1/analytics/throughput?limit=14")
    assert throughput.status_code == 200, throughput.text
    assert throughput.json()["daily"] == [
        {
            "event_date": "2026-10-20",
            "events": 120,
            "redelivered_copies": 1,
        }
    ]


def test_orders_endpoint_filters_and_paginates_published_rows(
    client: TestClient, engine: Engine
) -> None:
    report_id = uuid.uuid4()
    snapshot_id = uuid.uuid4()
    wanted = uuid.uuid4()
    other = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(
            insert(reconciliation_reports).values(
                report_id=report_id,
                status="passed",
                scope={},
                metrics={},
                violations=[],
                triggered_by="test:analytics",
            )
        )
        conn.execute(
            insert(analytics_snapshots).values(
                snapshot_id=snapshot_id,
                reconciliation_report_id=report_id,
                reconciliation_status="passed",
                model_counts={},
            )
        )
        conn.execute(
            insert(analytics_model_rows),
            [
                {
                    "snapshot_id": snapshot_id,
                    "model_name": "gold_order_fulfilment",
                    "row_index": 0,
                    "row_data": {"simulation_id": str(wanted), "order_id": "wanted-1"},
                },
                {
                    "snapshot_id": snapshot_id,
                    "model_name": "gold_order_fulfilment",
                    "row_index": 1,
                    "row_data": {"simulation_id": str(wanted), "order_id": "wanted-2"},
                },
                {
                    "snapshot_id": snapshot_id,
                    "model_name": "gold_order_fulfilment",
                    "row_index": 2,
                    "row_data": {"simulation_id": str(other), "order_id": "other"},
                },
            ],
        )

    response = client.get(
        "/api/v1/analytics/orders",
        params={"simulation_id": str(wanted), "limit": 1, "offset": 1},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["page"] == {"limit": 1, "offset": 1, "total": 2}
    assert [row["order_id"] for row in body["rows"]] == ["wanted-2"]


def test_analytics_returns_stable_error_before_first_publication(client: TestClient) -> None:
    response = client.get("/api/v1/analytics/overview")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ANALYTICS_NOT_PUBLISHED"
