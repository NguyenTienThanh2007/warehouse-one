"""Fixtures for tests against a real PostgreSQL (WAREHOUSE_DATABASE_URL)."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text

from tests.conftest import REPO_ROOT, make_client
from warehouse_api.config import Settings

OPS_TABLES = ["outbox", "domain_events", "command_log", "ingest_batches", "simulation_runs"]
PIPE_TABLES = [
    "consumer_events",
    "aggregate_versions",
    "data_quality_issues",
    "dead_letters",
    "bronze_objects",
    "heartbeats",
    "reconciliation_reports",
]


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings()  # reads WAREHOUSE_DATABASE_URL


@pytest.fixture(scope="session")
def migrated(settings: Settings, pytestconfig: pytest.Config) -> str:
    cfg = Config(str(pytestconfig.rootpath / "alembic.ini"))
    command.upgrade(cfg, "head")
    return str(settings.database_url)


@pytest.fixture
def engine(migrated: str) -> Iterator[Engine]:
    eng = create_engine(migrated)
    truncate(eng)
    yield eng
    eng.dispose()


def truncate(eng: Engine) -> None:
    tables = (
        [f"operations.{t}" for t in OPS_TABLES]
        + [f"pipeline.{t}" for t in PIPE_TABLES]
        + ["analytics.snapshots"]  # its rows cascade to every other analytics table
    )
    with eng.begin() as conn:
        conn.execute(text(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE"))


@pytest.fixture
def client(engine: Engine, settings: Settings) -> Iterator[TestClient]:
    with make_client(settings, engine) as c:
        yield c


class RunFixture:
    """A recorded run from data/fixtures: config, command log (with ticks) and events."""

    def __init__(self, name: str) -> None:
        root = REPO_ROOT / "data/fixtures" / name
        self.config: dict[str, Any] = json.loads((root / "config.json").read_text())
        self.commands: list[dict[str, Any]] = [
            json.loads(line) for line in (root / "commands.jsonl").read_text().splitlines()
        ]
        self.events: list[dict[str, Any]] = [
            json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()
        ]
        self.summary: dict[str, Any] = json.loads((root / "summary.json").read_text())

    @property
    def simulation_id(self) -> str:
        return str(self.config["simulation_id"])

    def tick_of(self, event: dict[str, Any]) -> int:
        return int(event["simulation_time_ms"]) // int(self.config["tick_ms"])

    def batches(self, size: int) -> list[dict[str, Any]]:
        """Split events into batches at tick boundaries where possible, carrying each tick's
        commands in the batch that first reaches that tick, as the recorder does."""
        out: list[dict[str, Any]] = []
        pending_cmds = list(self.commands)
        for start in range(0, len(self.events), size):
            chunk = self.events[start : start + size]
            through = self.tick_of(chunk[-1])
            cmds = [c for c in pending_cmds if c["tick"] <= through]
            pending_cmds = [c for c in pending_cmds if c["tick"] > through]
            out.append({"through_tick": through, "commands": cmds, "events": chunk})
        if pending_cmds:
            last = max(c["tick"] for c in pending_cmds)
            out.append({"through_tick": last, "commands": pending_cmds, "events": []})
        return out


@pytest.fixture(scope="session")
def ops_demo() -> RunFixture:
    return RunFixture("operations-demo")


def fixture_path(name: str) -> Path:
    return REPO_ROOT / "data/fixtures" / name


__all__ = ["RunFixture", "make_client"]
