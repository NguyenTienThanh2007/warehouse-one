"""Liveness, readiness and build metadata endpoints."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel
from sqlalchemy import Engine

from warehouse_api import __version__
from warehouse_api.config import Settings, get_settings
from warehouse_api.db import check_database, get_engine

router = APIRouter(tags=["health"])


class Liveness(BaseModel):
    status: Literal["ok"]
    service: str
    version: str


class DependencyCheck(BaseModel):
    status: Literal["ok", "unavailable"]
    latency_ms: float | None = None
    error: str | None = None


class Readiness(BaseModel):
    status: Literal["ready", "not_ready"]
    checks: dict[str, DependencyCheck]


class VersionInfo(BaseModel):
    service: str
    version: str
    git_sha: str
    environment: str


SERVICE = "warehouse-api"


@router.get("/health", response_model=Liveness)
def liveness() -> Liveness:
    """The process is up. Does not touch dependencies (safe for frequent container probes)."""
    return Liveness(status="ok", service=SERVICE, version=__version__)


@router.get(
    "/health/ready",
    response_model=Readiness,
    responses={503: {"model": Readiness, "description": "A dependency is unavailable"}},
)
def readiness(
    response: Response,
    engine: Annotated[Engine, Depends(get_engine)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Readiness:
    """Ready to serve traffic: required dependencies (PostgreSQL) respond."""
    db = check_database(engine)
    check = DependencyCheck(
        status="ok" if db.ok else "unavailable",
        latency_ms=db.latency_ms,
        error=db.error if settings.expose_error_details else None,
    )
    if not db.ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return Readiness(status="ready" if db.ok else "not_ready", checks={"database": check})


@router.get("/version", response_model=VersionInfo)
def version(settings: Annotated[Settings, Depends(get_settings)]) -> VersionInfo:
    return VersionInfo(
        service=SERVICE, version=__version__, git_sha=settings.git_sha, environment=settings.env
    )
