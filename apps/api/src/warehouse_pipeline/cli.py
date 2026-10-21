"""`warehouse-pipeline` command line: one entry point for every data-platform process.

warehouse-pipeline init-topics             create Kafka topics (idempotent)
warehouse-pipeline init-lake               create the lake bucket (idempotent)
warehouse-pipeline relay                   run the outbox relay until SIGTERM
warehouse-pipeline consume ledger|bronze   run a consumer until SIGTERM
warehouse-pipeline bronze-rebuild --start D --end D   rebuild bronze from PostgreSQL
warehouse-pipeline health <component>      exit 0 if a fresh `ok` heartbeat exists
"""

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from datetime import date
from uuid import UUID

from sqlalchemy import Engine, create_engine

from warehouse_api.logging import configure_logging
from warehouse_pipeline import heartbeat, ops
from warehouse_pipeline.analytics_publish import publish_analytics_snapshot
from warehouse_pipeline.bronze import BronzeProcessor, rebuild_from_postgres
from warehouse_pipeline.consumer import ConsumerService
from warehouse_pipeline.kafka import ensure_topics
from warehouse_pipeline.lake import ensure_bucket
from warehouse_pipeline.ledger import LedgerProcessor
from warehouse_pipeline.reconcile import Scope, reconcile
from warehouse_pipeline.relay import OutboxRelay
from warehouse_pipeline.settings import PipelineSettings, get_pipeline_settings

Command = Callable[[argparse.Namespace, PipelineSettings], int]


def _engine(settings: PipelineSettings) -> Engine:
    return create_engine(settings.sqlalchemy_url, pool_pre_ping=True, pool_size=3, max_overflow=2)


def _print(value: object) -> None:
    print(json.dumps(value, default=str))


def init_topics(_args: argparse.Namespace, settings: PipelineSettings) -> int:
    _print(ensure_topics(settings))
    return 0


def init_lake(_args: argparse.Namespace, settings: PipelineSettings) -> int:
    ensure_bucket(settings)
    _print({"bucket": settings.lake_bucket, "status": "ready"})
    return 0


def relay(_args: argparse.Namespace, settings: PipelineSettings) -> int:
    service = OutboxRelay(_engine(settings), settings)
    service.install_signal_handlers()
    service.run_forever()
    return 0


def consume(args: argparse.Namespace, settings: PipelineSettings) -> int:
    processor: LedgerProcessor | BronzeProcessor = (
        LedgerProcessor() if args.group == "ledger" else BronzeProcessor(settings)
    )
    service = ConsumerService(_engine(settings), settings, processor)
    service.install_signal_handlers()
    service.run_forever()
    return 0


def bronze_rebuild(args: argparse.Namespace, settings: PipelineSettings) -> int:
    result = rebuild_from_postgres(_engine(settings), settings, args.start, args.end)
    _print(
        {
            "objects": len(result.objects),
            "records": sum(o.record_count for o in result.objects),
            "keys": [o.key for o in result.objects],
            "pruned_manifest_keys": result.pruned_manifest_keys,
        }
    )
    return 0


def reconcile_cmd(args: argparse.Namespace, settings: PipelineSettings) -> int:
    report = reconcile(
        _engine(settings),
        settings,
        Scope(
            start=args.start,
            end=args.end,
            settle_s=args.settle,
            require_models=not args.skip_models,
            triggered_by=args.triggered_by,
        ),
    )
    _print(
        {
            "report_id": report.report_id,
            "status": report.status,
            "report_object_key": report.object_key,
            "metrics": report.metrics,
            "violations": report.violations,
        }
    )
    return 1 if report.status == "failed" else 0


def status(args: argparse.Namespace, settings: PipelineSettings) -> int:
    _print(ops.run_status(_engine(settings), settings, args.simulation))
    return 0


def replay(args: argparse.Namespace, settings: PipelineSettings) -> int:
    _print(ops.replay(_engine(settings), settings, args.simulation, args.limit))
    return 0


def publish_analytics(_args: argparse.Namespace, settings: PipelineSettings) -> int:
    result = publish_analytics_snapshot(_engine(settings), settings)
    _print(result)
    return 0


def health(args: argparse.Namespace, settings: PipelineSettings) -> int:
    ok, report = heartbeat.check(_engine(settings), args.component, args.max_age)
    _print({"component": args.component, "healthy": ok, "instances": report})
    return 0 if ok else 1


COMMANDS: dict[str, Command] = {
    "init-topics": init_topics,
    "init-lake": init_lake,
    "relay": relay,
    "consume": consume,
    "bronze-rebuild": bronze_rebuild,
    "reconcile": reconcile_cmd,
    "status": status,
    "replay": replay,
    "health": health,
    "publish-analytics": publish_analytics,
}


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="warehouse-pipeline")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("init-topics", help="create Kafka topics if missing")
    sub.add_parser("init-lake", help="create the lake bucket if missing")
    sub.add_parser("relay", help="run the outbox relay")
    c = sub.add_parser("consume", help="run a consumer")
    c.add_argument("group", choices=["ledger", "bronze"])
    r = sub.add_parser("bronze-rebuild", help="rebuild bronze from the event log")
    r.add_argument("--start", type=date.fromisoformat, required=True)
    r.add_argument("--end", type=date.fromisoformat, required=True)
    rc = sub.add_parser("reconcile", help="reconcile source, ledger, lake and models")
    rc.add_argument("--start", type=date.fromisoformat, default=None)
    rc.add_argument("--end", type=date.fromisoformat, default=None)
    rc.add_argument("--settle", type=float, default=60.0, help="seconds since publish")
    rc.add_argument("--skip-models", action="store_true", help="do not require silver/gold")
    rc.add_argument("--triggered-by", default="cli")
    st = sub.add_parser("status", help="a run's counts through every layer")
    st.add_argument("--simulation", type=UUID, required=True)
    rp = sub.add_parser("replay", help="re-publish a run's stored events to Kafka")
    rp.add_argument("--simulation", type=UUID, required=True)
    rp.add_argument("--limit", type=int, default=None, help="first N events only")
    h = sub.add_parser("health", help="check a component's heartbeat")
    h.add_argument("component")
    h.add_argument("--max-age", type=float, default=30.0)
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    settings = get_pipeline_settings()
    configure_logging(settings.log_level)
    return COMMANDS[args.command](args, settings)


if __name__ == "__main__":
    sys.exit(main())
