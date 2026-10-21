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

from sqlalchemy import Engine, create_engine

from warehouse_api.logging import configure_logging
from warehouse_pipeline import heartbeat
from warehouse_pipeline.bronze import BronzeProcessor, rebuild_from_postgres
from warehouse_pipeline.consumer import ConsumerService
from warehouse_pipeline.kafka import ensure_topics
from warehouse_pipeline.lake import ensure_bucket
from warehouse_pipeline.ledger import LedgerProcessor
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
    objects = rebuild_from_postgres(_engine(settings), settings, args.start, args.end)
    _print(
        {
            "objects": len(objects),
            "records": sum(o.record_count for o in objects),
            "keys": [o.key for o in objects],
        }
    )
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
    "health": health,
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
