"""FastAPI application factory."""

import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from warehouse_api import __version__
from warehouse_api.api import analytics, health, simulations
from warehouse_api.api.errors import install_error_handlers
from warehouse_api.config import Settings, get_settings
from warehouse_api.logging import configure_logging, request_id_var

logger = logging.getLogger("warehouse_api.http")

REQUEST_ID_HEADER = "X-Request-ID"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="WAREHOUSE ONE API",
        version=__version__,
        description="Operational API for the WAREHOUSE ONE logistics digital twin.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["*"],
        expose_headers=[REQUEST_ID_HEADER],
    )

    @app.middleware("http")
    async def limit_body(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # Reject oversized bodies before parsing. Chunked bodies without a length are refused for
        # the ingestion API, so the limit cannot be bypassed.
        if request.method in {"POST", "PUT", "PATCH"} and request.url.path.startswith("/api/"):
            length = request.headers.get("content-length")
            if length is None or not length.isdigit():
                return _error(411, "LENGTH_REQUIRED", "a Content-Length header is required")
            if int(length) > settings.max_request_bytes:
                return _error(
                    413,
                    "BODY_TOO_LARGE",
                    f"request body exceeds {settings.max_request_bytes} bytes",
                )
        return await call_next(request)

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get(REQUEST_ID_HEADER, "")
        # Accept a caller-supplied ID only if it is short and printable; otherwise mint one.
        is_safe = 0 < len(incoming) <= 64 and incoming.isascii() and incoming.isprintable()
        request_id = incoming if is_safe else uuid.uuid4().hex
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers[REQUEST_ID_HEADER] = request_id
        logger.info(
            "request",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        return response

    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(simulations.router)
    app.include_router(analytics.router)
    return app


def _error(status: int, code: str, message: str) -> Response:
    return JSONResponse(
        status_code=status, content={"error": {"code": code, "message": message, "details": {}}}
    )


app = create_app()
