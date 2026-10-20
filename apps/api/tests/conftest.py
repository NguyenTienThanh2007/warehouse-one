from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine

from warehouse_api.config import Environment, Settings, get_settings
from warehouse_api.db import get_engine
from warehouse_api.main import create_app

REPO_ROOT = Path(__file__).resolve().parents[3]
UNREACHABLE_DB = "postgresql+psycopg://nobody:nothing@127.0.0.1:1/none"


@pytest.fixture
def repo_root() -> Path:
    return REPO_ROOT


def make_client(settings: Settings, engine: Engine) -> TestClient:
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app)


@pytest.fixture
def offline_client() -> Iterator[TestClient]:
    """App wired to a database that refuses connections (port 1)."""
    settings = Settings(env=Environment.TEST, database_url=UNREACHABLE_DB, git_sha="test-sha")
    engine = create_engine(UNREACHABLE_DB, connect_args={"connect_timeout": 1})
    with make_client(settings, engine) as client:
        yield client
    engine.dispose()
