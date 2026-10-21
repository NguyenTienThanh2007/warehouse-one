"""Reconciliation: PostgreSQL (source of truth) ↔ ledger ↔ dead letters ↔ bronze ↔ silver ↔ gold.

Scope: events stored for the configured Kafka topic whose outbox row was published at least
`settle_s` seconds ago (they had time to reach every consumer), optionally limited to a simulated
date range. Every comparison is by `event_id`; missing and unexpected IDs are listed (first 20).

Invariants (each violation is reported; any violation fails the run):
- every settled source event is in the ledger and in bronze, with an identical envelope hash;
- nothing in the ledger or bronze is unknown to the source;
- every bronze object is in the manifest with the same size, and every manifest entry exists;
- no dead letters and no data-quality issues in scope (they need a person to look at them);
- when silver and gold have been built: every settled event that was in bronze before the build
  is in silver (or explicitly rejected), and gold's event volume equals silver's event count.

The report is written to the lake (`reports/reconciliation/…json`) and to
`pipeline.reconciliation_reports`.
"""

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

import duckdb
from sqlalchemy import Engine, and_, func, select
from sqlalchemy.dialects.postgresql import insert

from warehouse_api.store.tables import (
    bronze_objects,
    consumer_events,
    data_quality_issues,
    dead_letters,
    domain_events,
    outbox,
    reconciliation_reports,
)
from warehouse_pipeline.lake import BRONZE_PREFIX, filesystem, list_objects
from warehouse_pipeline.ledger import GROUP as LEDGER_GROUP
from warehouse_pipeline.settings import PipelineSettings

log = logging.getLogger("warehouse_pipeline.reconcile")

SAMPLE = 20


@dataclass
class Scope:
    start: date | None = None
    end: date | None = None
    settle_s: float = 60.0
    require_models: bool = True
    triggered_by: str = "cli"


@dataclass
class Report:
    report_id: uuid.UUID
    status: str
    scope: dict[str, Any]
    metrics: dict[str, Any] = field(default_factory=dict)
    violations: list[dict[str, Any]] = field(default_factory=list)
    object_key: str | None = None

    def violate(self, check: str, count: int, detail: Any = None) -> None:
        if count:
            self.violations.append({"check": check, "count": count, "detail": detail})


def duck(settings: PipelineSettings) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # INSTALL is a no-op when the extension is present (the images install it at build time);
    # on a fresh machine it downloads it once into ~/.duckdb.
    con.execute("INSTALL httpfs")
    con.execute("LOAD httpfs")
    con.execute("SET s3_endpoint = ?", [settings.s3_endpoint])
    con.execute("SET s3_access_key_id = ?", [settings.s3_access_key.get_secret_value()])
    con.execute("SET s3_secret_access_key = ?", [settings.s3_secret_key.get_secret_value()])
    con.execute("SET s3_region = ?", [settings.s3_region])
    con.execute("SET s3_url_style = 'path'")
    con.execute(f"SET s3_use_ssl = {'true' if settings.s3_scheme == 'https' else 'false'}")
    return con


def _in_range(column: str, scope: Scope) -> str:
    parts = []
    if scope.start:
        parts.append(f"{column} >= DATE '{scope.start.isoformat()}'")
    if scope.end:
        parts.append(f"{column} <= DATE '{scope.end.isoformat()}'")
    return " AND ".join(parts) or "TRUE"


def _date_filter(scope: Scope) -> list[Any]:
    day = func.date(func.timezone("UTC", domain_events.c.occurred_at))
    out: list[Any] = []
    if scope.start:
        out.append(day >= scope.start)
    if scope.end:
        out.append(day <= scope.end)
    return out


def _source(engine: Engine, settings: PipelineSettings, scope: Scope) -> dict[str, Any]:
    settled_before = datetime.now(UTC) - timedelta(seconds=scope.settle_s)
    with engine.connect() as conn:
        rows = conn.execute(
            select(domain_events.c.event_id, domain_events.c.envelope_sha256, outbox.c.published_at)
            .join(outbox, outbox.c.event_id == domain_events.c.event_id)
            .where(and_(outbox.c.topic == settings.kafka_events_topic, *_date_filter(scope)))
        ).all()
    return {
        "settled": {str(r[0]): r[1] for r in rows if r[2] is not None and r[2] <= settled_before},
        "unpublished": sum(1 for r in rows if r[2] is None),
        "in_flight": sum(1 for r in rows if r[2] is not None and r[2] > settled_before),
        "all_ids": {str(r[0]) for r in rows},
    }


def reconcile(engine: Engine, settings: PipelineSettings, scope: Scope) -> Report:
    started = datetime.now(UTC)
    report = Report(
        report_id=uuid.uuid4(),
        status="passed",
        scope={
            "start": scope.start.isoformat() if scope.start else None,
            "end": scope.end.isoformat() if scope.end else None,
            "settle_s": scope.settle_s,
            "topic": settings.kafka_events_topic,
            "bucket": settings.lake_bucket,
            "require_models": scope.require_models,
            "triggered_by": scope.triggered_by,
        },
    )
    src = _source(engine, settings, scope)
    settled: dict[str, str] = src["settled"]
    ids = set(settled)
    m = report.metrics
    m["source_settled_events"] = len(ids)
    m["source_unpublished_events"] = src["unpublished"]
    m["source_in_flight_events"] = src["in_flight"]

    _check_ledger(engine, report, ids, settled)
    _check_dead_letters_and_issues(engine, report, src["all_ids"])
    ctx = _Ctx(engine, settings, duck(settings), report, scope, ids, settled)
    _check_models(ctx, _check_bronze(ctx))

    if report.violations:
        report.status = "failed"
    elif not ids and (src["unpublished"] or src["in_flight"]):
        report.status = "not_settled"
    _store(engine, settings, report, started)
    return report


def _check_ledger(engine: Engine, report: Report, ids: set[str], settled: dict[str, str]) -> None:
    with engine.connect() as conn:
        ledger = {
            str(r[0]): r[1]
            for r in conn.execute(
                select(consumer_events.c.event_id, consumer_events.c.envelope_sha256).where(
                    consumer_events.c.consumer_group == LEDGER_GROUP
                )
            )
        }
        known = {str(r[0]) for r in conn.execute(select(domain_events.c.event_id))}
    missing = sorted(ids - set(ledger))
    unexpected = sorted(set(ledger) - known)
    mismatched = sorted(i for i in ids & set(ledger) if ledger[i] != settled[i])
    report.metrics["ledger_events"] = len(set(ledger) & ids)
    report.violate("missing_in_ledger", len(missing), missing[:SAMPLE])
    report.violate("unexpected_in_ledger", len(unexpected), unexpected[:SAMPLE])
    report.violate("ledger_envelope_mismatch", len(mismatched), mismatched[:SAMPLE])


def _check_dead_letters_and_issues(engine: Engine, report: Report, scope_ids: set[str]) -> None:
    with engine.connect() as conn:
        dead = conn.execute(
            select(
                dead_letters.c.consumer_group,
                dead_letters.c.error_class,
                dead_letters.c.event_id,
                dead_letters.c.source_partition,
                dead_letters.c.source_offset,
            )
        ).all()
        issues = conn.execute(
            select(data_quality_issues.c.issue_type, data_quality_issues.c.event_id)
        ).all()
    # Dead letters without a parseable event_id cannot be scoped by date: always counted.
    in_scope = [d for d in dead if d[2] is None or d[2] in scope_ids]
    report.metrics["dead_letters"] = len(in_scope)
    report.violate(
        "dead_letters",
        len(in_scope),
        [
            {
                "group": d[0],
                "error_class": d[1],
                "event_id": d[2],
                "partition": d[3],
                "offset": d[4],
            }
            for d in in_scope[:SAMPLE]
        ],
    )
    scoped_issues = [i for i in issues if i[1] is None or str(i[1]) in scope_ids]
    report.metrics["data_quality_issues"] = len(scoped_issues)
    report.violate(
        "data_quality_issues",
        len(scoped_issues),
        [{"issue_type": i[0], "event_id": str(i[1])} for i in scoped_issues[:SAMPLE]],
    )


@dataclass
class _Ctx:
    engine: Engine
    settings: PipelineSettings
    con: duckdb.DuckDBPyConnection
    report: Report
    scope: Scope
    ids: set[str]
    settled: dict[str, str]


def _check_bronze(ctx: _Ctx) -> dict[str, datetime]:
    engine, settings, con, report = ctx.engine, ctx.settings, ctx.con, ctx.report
    scope, ids, settled = ctx.scope, ctx.ids, ctx.settled
    objects = list_objects(settings)
    with engine.connect() as conn:
        manifest = {
            r[0]: r[1]
            for r in conn.execute(select(bronze_objects.c.object_key, bronze_objects.c.size_bytes))
        }
        known = {str(r[0]) for r in conn.execute(select(domain_events.c.event_id))}
    orphans = sorted(set(objects) - set(manifest))
    lost = sorted(set(manifest) - set(objects))
    resized = sorted(k for k in set(objects) & set(manifest) if objects[k] != manifest[k])
    report.metrics["bronze_objects"] = len(objects)
    report.violate("bronze_objects_not_in_manifest", len(orphans), orphans[:SAMPLE])
    report.violate("manifest_objects_missing_from_store", len(lost), lost[:SAMPLE])
    report.violate("bronze_object_size_mismatch", len(resized), resized[:SAMPLE])

    first_seen: dict[str, datetime] = {}
    shas: dict[str, set[str]] = {}
    rows = 0
    if objects:
        glob = f"s3://{settings.lake_bucket}/{BRONZE_PREFIX}/**/*.parquet"
        result = con.execute(
            f"""
            SELECT event_id, envelope_sha256,
                   epoch_ms(min(ingested_at)) AS first_ms, count(*) AS copies
            FROM read_parquet(?, hive_partitioning = true, union_by_name = true)
            WHERE {_in_range("cast(event_date AS DATE)", scope)}
            GROUP BY event_id, envelope_sha256
            """,  # noqa: S608 - _in_range builds the WHERE from typed dates only
            [glob],
        ).fetchall()
        for event_id, sha, first_ms, copies in result:
            first = datetime.fromtimestamp(int(first_ms) / 1000, UTC)
            shas.setdefault(event_id, set()).add(sha)
            rows += int(copies)
            first_seen[event_id] = min(first_seen.get(event_id, first), first)
    bronze_ids = set(shas)
    missing = sorted(ids - bronze_ids)
    unexpected = sorted(bronze_ids - known)
    mismatched = sorted(i for i in ids & bronze_ids if shas[i] != {settled[i]})
    report.metrics["bronze_rows"] = rows
    report.metrics["bronze_distinct_events"] = len(bronze_ids)
    report.metrics["bronze_redelivered_copies"] = rows - len(bronze_ids)
    report.violate("missing_in_bronze", len(missing), missing[:SAMPLE])
    report.violate("unexpected_in_bronze", len(unexpected), unexpected[:SAMPLE])
    report.violate("bronze_envelope_mismatch", len(mismatched), mismatched[:SAMPLE])
    return first_seen


def _check_models(ctx: _Ctx, bronze_first_seen: dict[str, datetime]) -> None:
    settings, con, report, scope, ids = ctx.settings, ctx.con, ctx.report, ctx.scope, ctx.ids
    s3 = filesystem(settings)
    silver_key = f"{settings.lake_bucket}/silver/events.parquet"
    gold_key = f"{settings.lake_bucket}/gold/event_volume_daily.parquet"
    info = {i.path: i for i in s3.get_file_info([silver_key, gold_key])}
    silver_info = info[silver_key]
    if silver_info.mtime is None or info[gold_key].mtime is None:
        report.metrics["models_built"] = False
        if scope.require_models:
            report.violate("models_not_built", 1, "silver/gold Parquet objects do not exist")
        return
    report.metrics["models_built"] = True
    built_at = silver_info.mtime.astimezone(UTC)
    report.metrics["silver_built_at"] = built_at.isoformat()
    # dbt-duckdb writes one all-NULL placeholder row when an external model is empty (to keep its
    # schema) and hides it in its own views; readers outside dbt must filter it out too.
    where = f"event_id IS NOT NULL AND {_in_range('event_date', scope)}"
    silver = {
        r[0]
        for r in con.execute(
            f"SELECT event_id FROM read_parquet(?) WHERE {where}",  # noqa: S608 - typed dates
            [f"s3://{silver_key}"],
        ).fetchall()
    }
    rejected = {
        r[0]
        for r in con.execute(
            "SELECT event_id FROM read_parquet(?) WHERE event_id IS NOT NULL",
            [f"s3://{settings.lake_bucket}/silver/rejected_events.parquet"],
        ).fetchall()
    }
    expected = {i for i in ids if i in bronze_first_seen and bronze_first_seen[i] <= built_at}
    missing = sorted(expected - silver - rejected)
    report.metrics["silver_events"] = len(silver)
    report.metrics["silver_rejected_events"] = len(rejected)
    report.metrics["silver_expected_from_source"] = len(expected)
    report.violate("missing_in_silver", len(missing), missing[:SAMPLE])
    in_rejected = sorted(expected & rejected)
    report.violate("source_events_rejected_by_silver", len(in_rejected), in_rejected[:SAMPLE])
    gold_total = con.execute(
        "SELECT coalesce(sum(events), 0) FROM read_parquet(?) "  # noqa: S608 - typed dates
        f"WHERE events IS NOT NULL AND {_in_range('event_date', scope)}",
        [f"s3://{gold_key}"],
    ).fetchone()
    gold_events = int(gold_total[0]) if gold_total else 0
    report.metrics["gold_event_volume"] = gold_events
    report.violate(
        "gold_volume_differs_from_silver",
        int(gold_events != len(silver)),
        {"gold": gold_events, "silver": len(silver)},
    )


def _store(engine: Engine, settings: PipelineSettings, report: Report, started: datetime) -> None:
    key = f"reports/reconciliation/{started.strftime('%Y%m%dT%H%M%SZ')}-{report.report_id}.json"
    body = json.dumps(
        {
            "report_id": str(report.report_id),
            "status": report.status,
            "started_at": started.isoformat(),
            "scope": report.scope,
            "metrics": report.metrics,
            "violations": report.violations,
        },
        indent=2,
        default=str,
    ).encode()
    try:
        with filesystem(settings).open_output_stream(f"{settings.lake_bucket}/{key}") as out:
            out.write(body)
        report.object_key = key
    except OSError:
        log.exception("could not write the report to the lake; keeping the database copy")
    with engine.begin() as conn:
        conn.execute(
            insert(reconciliation_reports).values(
                report_id=report.report_id,
                status=report.status,
                scope=report.scope,
                metrics=json.loads(json.dumps(report.metrics, default=str)),
                violations=json.loads(json.dumps(report.violations, default=str)),
                report_object_key=report.object_key,
                triggered_by=report.scope.get("triggered_by", "cli"),
                started_at=started,
            )
        )
