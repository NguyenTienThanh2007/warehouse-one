"""`warehouse-pipeline` command line: one entry point for every data-platform process.

warehouse-pipeline init-topics             create Kafka topics (idempotent)
warehouse-pipeline relay                   run the outbox relay until SIGTERM
warehouse-pipeline health <component>      exit 0 if a fresh `ok` heartbeat exists
"""

import argparse
import json
import sys
from collections.abc import Sequence

from sqlalchemy import Engine, create_engine

from warehouse_api.logging import configure_logging
from warehouse_pipeline import heartbeat
from warehouse_pipeline.kafka import ensure_topics
from warehouse_pipeline.relay import OutboxRelay
from warehouse_pipeline.settings import PipelineSettings, get_pipeline_settings


def _engine(settings: PipelineSettings) -> Engine:
    return create_engine(settings.sqlalchemy_url, pool_pre_ping=True, pool_size=3, max_overflow=2)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="warehouse-pipeline")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init-topics", help="create Kafka topics if missing")
    sub.add_parser("relay", help="run the outbox relay")
    health = sub.add_parser("health", help="check a component's heartbeat")
    health.add_argument("component")
    health.add_argument("--max-age", type=float, default=30.0)
    args = parser.parse_args(argv)

    settings = get_pipeline_settings()
    configure_logging(settings.log_level)

    if args.command == "init-topics":
        print(json.dumps(ensure_topics(settings)))
        return 0
    if args.command == "relay":
        relay = OutboxRelay(_engine(settings), settings)
        relay.install_signal_handlers()
        relay.run_forever()
        return 0
    if args.command == "health":
        ok, report = heartbeat.check(_engine(settings), args.component, args.max_age)
        print(json.dumps({"component": args.component, "healthy": ok, "instances": report}))
        return 0 if ok else 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
