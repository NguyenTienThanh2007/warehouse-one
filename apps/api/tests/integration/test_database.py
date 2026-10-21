"""Integration tests against a real PostgreSQL. Run with: uv run pytest -m integration"""

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from tests.conftest import make_client
from warehouse_api.config import Settings

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def settings() -> Settings:
    return Settings()  # reads WAREHOUSE_DATABASE_URL


def test_readiness_is_ready_with_live_database(settings: Settings) -> None:
    engine = create_engine(str(settings.database_url))
    with make_client(settings, engine) as client:
        response = client.get("/health/ready")
    engine.dispose()
    assert response.status_code == 200, response.text
    assert response.json()["checks"]["database"]["status"] == "ok"


def test_migrations_upgrade_downgrade_roundtrip(
    settings: Settings, request: pytest.FixtureRequest
) -> None:
    cfg = Config(str(request.config.rootpath / "alembic.ini"))
    engine = create_engine(str(settings.database_url))
    command.upgrade(cfg, "head")
    assert {"operations", "pipeline", "analytics"} <= set(inspect(engine).get_schema_names())
    assert "outbox" in inspect(engine).get_table_names(schema="operations")
    command.downgrade(cfg, "base")
    assert not {"operations", "pipeline", "analytics"} & set(inspect(engine).get_schema_names())
    command.upgrade(cfg, "head")
    assert {"operations", "pipeline"} <= set(inspect(engine).get_schema_names())
    engine.dispose()
