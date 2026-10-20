import json
import logging

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from tests.conftest import UNREACHABLE_DB, make_client
from warehouse_api.config import Environment, Settings
from warehouse_api.logging import JsonFormatter


def test_liveness_is_ok_without_database(offline_client: TestClient) -> None:
    response = offline_client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "warehouse-api", "version": "0.1.0"}


def test_readiness_reports_unavailable_database_as_503(offline_client: TestClient) -> None:
    response = offline_client.get("/health/ready")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "not_ready"
    assert body["checks"]["database"]["status"] == "unavailable"
    assert body["checks"]["database"]["error"] == "OperationalError"


def test_production_hides_dependency_error_details() -> None:
    settings = Settings(env=Environment.PRODUCTION, database_url=UNREACHABLE_DB)
    engine = create_engine(UNREACHABLE_DB, connect_args={"connect_timeout": 1})
    with make_client(settings, engine) as client:
        body = client.get("/health/ready").json()
    assert body["checks"]["database"]["error"] is None


def test_version_reports_build_metadata(offline_client: TestClient) -> None:
    assert offline_client.get("/version").json() == {
        "service": "warehouse-api",
        "version": "0.1.0",
        "git_sha": "test-sha",
        "environment": "test",
    }


def test_request_id_is_generated_or_propagated(offline_client: TestClient) -> None:
    generated = offline_client.get("/health").headers["X-Request-ID"]
    assert len(generated) == 32
    echoed = offline_client.get("/health", headers={"X-Request-ID": "abc-123"})
    assert echoed.headers["X-Request-ID"] == "abc-123"


@pytest.mark.parametrize("bad", [b"x" * 65, b"evil\x01id", "caf\u00e9".encode("latin-1")])
def test_unsafe_request_ids_are_replaced(offline_client: TestClient, bad: bytes) -> None:
    response = offline_client.get("/health", headers={"X-Request-ID": bad})
    replaced = response.headers["X-Request-ID"]
    assert replaced.encode("latin-1") != bad
    assert len(replaced) == 32


def test_cors_allows_configured_web_origin(offline_client: TestClient) -> None:
    response = offline_client.get("/health", headers={"Origin": "http://localhost:3000"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    blocked = offline_client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in blocked.headers


def test_json_log_formatter_emits_structured_fields() -> None:
    record = logging.makeLogRecord(
        {"name": "t", "levelname": "INFO", "levelno": 20, "msg": "hello", "path": "/health"}
    )
    entry = json.loads(JsonFormatter().format(record))
    assert entry["msg"] == "hello"
    assert entry["level"] == "info"
    assert entry["path"] == "/health"
    assert entry["ts"].endswith("+00:00")


def test_unknown_route_returns_404(offline_client: TestClient) -> None:
    assert offline_client.get("/does-not-exist").status_code == 404
