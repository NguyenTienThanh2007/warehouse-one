"""PostgreSQL tables (SQLAlchemy Core). Created by Alembic migrations, never by create_all().

Schema `operations` is the durable source of truth written by the API: simulation runs, their
command logs, append-only domain events and the transactional outbox. Schema `pipeline` holds the
state of downstream components (consumers, bronze manifest, dead letters, heartbeats,
reconciliation reports). Schema `analytics` (Phase 4) holds published analytics snapshots:
an immutable, derived copy of reconciled dbt gold models that the read API serves (DEC-036);
it is never a source for anything else. Schema `twin` (Phase 6) holds decision-support proposals:
what the optimiser evaluated (with its input snapshot), the human decision and an append-only
audit trail, plus AI explanations. tests/integration/test_store_schema.py checks that the
migrations produce exactly these tables.

Time columns: `occurred_at` and `simulation_time_ms` are deterministic simulated business time
copied from the event. Columns ending in `_at` without that meaning (`registered_at`,
`recorded_at`, `published_at`, ...) are wall-clock operational timestamps set by the database.
"""

from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

metadata = MetaData(
    naming_convention={
        "ix": "ix_%(table_name)s_%(column_0_N_name)s",
        "uq": "uq_%(table_name)s_%(column_0_N_name)s",
        "ck": "ck_%(table_name)s_%(constraint_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "pk": "pk_%(table_name)s",
    }
)

OPS = "operations"
PIPE = "pipeline"
ANALYTICS = "analytics"
TWIN = "twin"


def wall_clock(name: str, nullable: bool = False) -> Column[Any]:
    """A wall-clock operational timestamp set by the database server."""
    return Column(
        name,
        DateTime(timezone=True),
        nullable=nullable,
        server_default=None if nullable else func.now(),
    )


simulation_runs = Table(
    "simulation_runs",
    metadata,
    Column("simulation_id", UUID(as_uuid=True), primary_key=True),
    Column("scenario_id", Text, nullable=True),
    Column("seed", Text, nullable=False),
    Column("engine_version", Text, nullable=False),
    Column("tick_ms", Integer, nullable=False),
    # Simulated epoch of the run (business time origin), not a wall-clock value.
    Column("epoch", DateTime(timezone=True), nullable=False),
    Column("config", JSONB, nullable=False),
    Column("config_sha256", Text, nullable=False),
    Column("source", Text, nullable=False),
    wall_clock("registered_at"),
    Column("last_sequence", BigInteger, nullable=False, server_default=text("0")),
    Column("last_simulation_time_ms", BigInteger, nullable=False, server_default=text("0")),
    Column("through_tick", BigInteger, nullable=False, server_default=text("0")),
    Column("event_count", BigInteger, nullable=False, server_default=text("0")),
    Column("command_count", BigInteger, nullable=False, server_default=text("0")),
    # Outbox relay lease and backoff for this run (DEC-025).
    Column("relay_owner", Text, nullable=True),
    wall_clock("relay_lease_until", nullable=True),
    wall_clock("relay_next_attempt_at", nullable=True),
    Column("relay_failures", Integer, nullable=False, server_default=text("0")),
    Column("relay_last_error", Text, nullable=True),
    CheckConstraint("tick_ms > 0", name="tick_ms_positive"),
    CheckConstraint("source IN ('web', 'recorder', 'test')", name="source_known"),
    schema=OPS,
)

ingest_batches = Table(
    "ingest_batches",
    metadata,
    Column("batch_id", UUID(as_uuid=True), primary_key=True),
    Column(
        "simulation_id",
        UUID(as_uuid=True),
        ForeignKey(f"{OPS}.simulation_runs.simulation_id"),
        nullable=False,
    ),
    Column("request_sha256", Text, nullable=False),
    Column("first_sequence", BigInteger, nullable=True),
    Column("last_sequence", BigInteger, nullable=True),
    Column("through_tick", BigInteger, nullable=False),
    Column("accepted_events", Integer, nullable=False),
    Column("duplicate_events", Integer, nullable=False),
    Column("accepted_commands", Integer, nullable=False),
    Column("duplicate_commands", Integer, nullable=False),
    wall_clock("received_at"),
    Index(None, "simulation_id"),
    schema=OPS,
)

command_log = Table(
    "command_log",
    metadata,
    Column(
        "simulation_id",
        UUID(as_uuid=True),
        ForeignKey(f"{OPS}.simulation_runs.simulation_id"),
        nullable=False,
    ),
    Column("command_id", Text, nullable=False),
    # Position in the run's command log (replay applies commands of a tick in this order).
    Column("log_index", BigInteger, nullable=False),
    # The tick at which the runner applied the command (replay input).
    Column("tick", BigInteger, nullable=False),
    Column("command_type", Text, nullable=False),
    Column("command", JSONB, nullable=False),
    Column("command_sha256", Text, nullable=False),
    Column("batch_id", UUID(as_uuid=True), nullable=False),
    wall_clock("recorded_at"),
    PrimaryKeyConstraint("simulation_id", "command_id"),
    UniqueConstraint("simulation_id", "log_index"),
    CheckConstraint("tick >= 1", name="tick_positive"),
    schema=OPS,
)

domain_events = Table(
    "domain_events",
    metadata,
    Column("event_id", UUID(as_uuid=True), primary_key=True),
    Column(
        "simulation_id",
        UUID(as_uuid=True),
        ForeignKey(f"{OPS}.simulation_runs.simulation_id"),
        nullable=False,
    ),
    Column("sequence", BigInteger, nullable=False),
    Column("event_type", Text, nullable=False),
    Column("schema_version", Integer, nullable=False),
    Column("aggregate_type", Text, nullable=False),
    Column("aggregate_id", Text, nullable=False),
    Column("aggregate_version", BigInteger, nullable=False),
    # Simulated business time (deterministic).
    Column("occurred_at", DateTime(timezone=True), nullable=False),
    Column("simulation_time_ms", BigInteger, nullable=False),
    Column("correlation_id", Text, nullable=False),
    Column("causation_id", Text, nullable=False),
    Column("payload", JSONB, nullable=False),
    # The envelope exactly as validated, and the hash of its canonical JSON (duplicate detection).
    Column("envelope", JSONB, nullable=False),
    Column("envelope_sha256", Text, nullable=False),
    Column("batch_id", UUID(as_uuid=True), nullable=False),
    wall_clock("recorded_at"),
    UniqueConstraint("simulation_id", "sequence"),
    UniqueConstraint("simulation_id", "aggregate_type", "aggregate_id", "aggregate_version"),
    Index(None, "occurred_at"),
    CheckConstraint("sequence >= 1", name="sequence_positive"),
    CheckConstraint("aggregate_version >= 1", name="version_positive"),
    schema=OPS,
)

outbox = Table(
    "outbox",
    metadata,
    Column("outbox_id", BigInteger, Identity(always=True), primary_key=True),
    Column(
        "event_id",
        UUID(as_uuid=True),
        ForeignKey(f"{OPS}.domain_events.event_id"),
        nullable=False,
        unique=True,
    ),
    Column("simulation_id", UUID(as_uuid=True), nullable=False),
    Column("sequence", BigInteger, nullable=False),
    Column("topic", Text, nullable=False),
    Column("message_key", Text, nullable=False),
    # UTF-8 canonical JSON of the envelope: exactly the bytes published to Kafka.
    Column("message_value", LargeBinary, nullable=False),
    Column("headers", JSONB, nullable=False),
    wall_clock("created_at"),
    wall_clock("published_at", nullable=True),
    Column("kafka_partition", Integer, nullable=True),
    Column("kafka_offset", BigInteger, nullable=True),
    Column("attempts", Integer, nullable=False, server_default=text("0")),
    wall_clock("last_attempt_at", nullable=True),
    Column("last_error", Text, nullable=True),
    Index(
        "ix_outbox_unpublished",
        "simulation_id",
        "sequence",
        postgresql_where=text("published_at IS NULL"),
    ),
    schema=OPS,
)

# Downstream (pipeline) state ---------------------------------------------------------------

consumer_events = Table(
    "consumer_events",
    metadata,
    Column("consumer_group", Text, nullable=False),
    Column("event_id", UUID(as_uuid=True), nullable=False),
    Column("simulation_id", UUID(as_uuid=True), nullable=False),
    Column("sequence", BigInteger, nullable=False),
    Column("event_type", Text, nullable=False),
    Column("aggregate_type", Text, nullable=False),
    Column("aggregate_id", Text, nullable=False),
    Column("aggregate_version", BigInteger, nullable=False),
    Column("envelope_sha256", Text, nullable=False),
    Column("kafka_topic", Text, nullable=False),
    Column("kafka_partition", Integer, nullable=False),
    Column("kafka_offset", BigInteger, nullable=False),
    wall_clock("first_processed_at"),
    # Every redelivery is counted, so duplicates leave evidence instead of disappearing.
    Column("delivery_count", Integer, nullable=False, server_default=text("1")),
    wall_clock("last_delivered_at"),
    PrimaryKeyConstraint("consumer_group", "event_id"),
    Index(None, "consumer_group", "simulation_id", "sequence"),
    schema=PIPE,
)

aggregate_versions = Table(
    "aggregate_versions",
    metadata,
    Column("consumer_group", Text, nullable=False),
    Column("simulation_id", UUID(as_uuid=True), nullable=False),
    Column("aggregate_type", Text, nullable=False),
    Column("aggregate_id", Text, nullable=False),
    Column("last_version", BigInteger, nullable=False),
    Column("last_event_id", UUID(as_uuid=True), nullable=False),
    wall_clock("updated_at"),
    PrimaryKeyConstraint("consumer_group", "simulation_id", "aggregate_type", "aggregate_id"),
    schema=PIPE,
)

data_quality_issues = Table(
    "data_quality_issues",
    metadata,
    Column("issue_id", BigInteger, Identity(always=True), primary_key=True),
    Column("consumer_group", Text, nullable=False),
    Column("issue_type", Text, nullable=False),
    Column("simulation_id", UUID(as_uuid=True), nullable=True),
    Column("event_id", UUID(as_uuid=True), nullable=True),
    Column("details", JSONB, nullable=False),
    Column("kafka_topic", Text, nullable=False),
    Column("kafka_partition", Integer, nullable=False),
    Column("kafka_offset", BigInteger, nullable=False),
    wall_clock("detected_at"),
    UniqueConstraint(
        "consumer_group", "issue_type", "kafka_topic", "kafka_partition", "kafka_offset"
    ),
    schema=PIPE,
)

dead_letters = Table(
    "dead_letters",
    metadata,
    Column("dead_letter_id", BigInteger, Identity(always=True), primary_key=True),
    Column("consumer_group", Text, nullable=False),
    Column("error_class", Text, nullable=False),
    Column("error_detail", Text, nullable=False),
    Column("event_id", Text, nullable=True),
    Column("simulation_id", Text, nullable=True),
    Column("source_topic", Text, nullable=False),
    Column("source_partition", Integer, nullable=False),
    Column("source_offset", BigInteger, nullable=False),
    Column("message_key", LargeBinary, nullable=True),
    Column("message_value", LargeBinary, nullable=True),
    Column("headers", JSONB, nullable=False),
    Column("dlq_topic", Text, nullable=False),
    Column("dlq_partition", Integer, nullable=True),
    Column("dlq_offset", BigInteger, nullable=True),
    wall_clock("failed_at"),
    UniqueConstraint("consumer_group", "source_topic", "source_partition", "source_offset"),
    schema=PIPE,
)

bronze_objects = Table(
    "bronze_objects",
    metadata,
    Column("object_key", Text, primary_key=True),
    Column("consumer_group", Text, nullable=False),
    Column("source", Text, nullable=False),
    Column("kafka_topic", Text, nullable=True),
    Column("kafka_partition", Integer, nullable=True),
    Column("first_offset", BigInteger, nullable=True),
    Column("last_offset", BigInteger, nullable=True),
    Column("event_date", Text, nullable=False),
    Column("event_type", Text, nullable=False),
    Column("record_count", Integer, nullable=False),
    Column("size_bytes", BigInteger, nullable=False),
    Column("sha256", Text, nullable=False),
    Column("pipeline_version", Text, nullable=False),
    wall_clock("written_at"),
    CheckConstraint("source IN ('kafka', 'postgres-rebuild')", name="source_known"),
    schema=PIPE,
)

heartbeats = Table(
    "heartbeats",
    metadata,
    Column("component", Text, nullable=False),
    Column("instance", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("details", JSONB, nullable=False),
    wall_clock("last_beat_at"),
    PrimaryKeyConstraint("component", "instance"),
    CheckConstraint("status IN ('ok', 'degraded', 'stopping')", name="status_known"),
    schema=PIPE,
)

reconciliation_reports = Table(
    "reconciliation_reports",
    metadata,
    Column("report_id", UUID(as_uuid=True), primary_key=True),
    Column("status", Text, nullable=False),
    Column("scope", JSONB, nullable=False),
    Column("metrics", JSONB, nullable=False),
    Column("violations", JSONB, nullable=False),
    Column("report_object_key", Text, nullable=True),
    Column("triggered_by", Text, nullable=False),
    wall_clock("started_at"),
    wall_clock("finished_at"),
    CheckConstraint("status IN ('passed', 'failed', 'not_settled')", name="status_known"),
    schema=PIPE,
)

# --- Phase 4: published analytics snapshots (DEC-036) -------------------------------------------
# Simulated time is stored as milliseconds since the run's simulated clock origin (`*_ms`); the run
# row carries that origin (`run_epoch`), so business timestamps are `run_epoch + ms`.


def _snapshot_fk() -> Column[Any]:
    return Column(
        "snapshot_id",
        UUID(as_uuid=True),
        ForeignKey(f"{ANALYTICS}.snapshots.snapshot_id", ondelete="CASCADE"),
        nullable=False,
    )


analytics_snapshots = Table(
    "snapshots",
    metadata,
    Column("snapshot_id", UUID(as_uuid=True), primary_key=True),
    Column("catalogue_version", Integer, nullable=False),
    wall_clock("generated_at"),
    Column("triggered_by", Text, nullable=False),
    # Lineage: the gold build and the reconciliation that cleared it for publication.
    Column("gold_built_at", DateTime(timezone=True), nullable=False),
    Column("reconciliation_report_id", UUID(as_uuid=True), nullable=True),
    Column("reconciliation_status", Text, nullable=False),
    Column("reconciliation_finished_at", DateTime(timezone=True), nullable=True),
    # Latest wall-clock ingestion time of any event included (bronze `ingested_at`).
    Column("source_watermark", DateTime(timezone=True), nullable=True),
    Column("source_events", BigInteger, nullable=False),
    Column("run_count", Integer, nullable=False),
    # Simulated business-time range covered by the included runs.
    Column("business_from", DateTime(timezone=True), nullable=True),
    Column("business_to", DateTime(timezone=True), nullable=True),
    CheckConstraint(
        "reconciliation_status IN ('passed', 'not_required')", name="reconciled_status_known"
    ),
    schema=ANALYTICS,
)

analytics_runs = Table(
    "snapshot_runs",
    metadata,
    _snapshot_fk(),
    Column("simulation_id", UUID(as_uuid=True), nullable=False),
    Column("scenario_id", Text, nullable=True),
    Column("run_epoch", DateTime(timezone=True), nullable=False),
    Column("events", BigInteger, nullable=False),
    Column("event_types", Integer, nullable=False),
    Column("first_sequence", BigInteger, nullable=False),
    Column("last_sequence", BigInteger, nullable=False),
    Column("missing_sequences", BigInteger, nullable=False),
    Column("redelivered_copies", BigInteger, nullable=False),
    Column("first_simulation_time_ms", BigInteger, nullable=False),
    Column("last_simulation_time_ms", BigInteger, nullable=False),
    PrimaryKeyConstraint("snapshot_id", "simulation_id"),
    schema=ANALYTICS,
)

analytics_metric_buckets = Table(
    "metric_buckets",
    metadata,
    _snapshot_fk(),
    Column("simulation_id", UUID(as_uuid=True), nullable=False),
    Column("metric", Text, nullable=False),
    Column("dimension", Text, nullable=False),
    Column("bucket_ms", BigInteger, nullable=False),
    Column("value", BigInteger, nullable=False),
    PrimaryKeyConstraint("snapshot_id", "simulation_id", "metric", "dimension", "bucket_ms"),
    schema=ANALYTICS,
)

analytics_task_facts = Table(
    "task_facts",
    metadata,
    _snapshot_fk(),
    Column("simulation_id", UUID(as_uuid=True), nullable=False),
    Column("task_id", Text, nullable=False),
    Column("task_type", Text, nullable=True),
    Column("status", Text, nullable=False),
    Column("created_ms", BigInteger, nullable=True),
    Column("assigned_ms", BigInteger, nullable=True),
    Column("completed_ms", BigInteger, nullable=True),
    Column("cancelled_ms", BigInteger, nullable=True),
    PrimaryKeyConstraint("snapshot_id", "simulation_id", "task_id"),
    schema=ANALYTICS,
)

analytics_order_facts = Table(
    "order_facts",
    metadata,
    _snapshot_fk(),
    Column("simulation_id", UUID(as_uuid=True), nullable=False),
    Column("order_id", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("ordered_pallets", BigInteger, nullable=True),
    Column("opened_ms", BigInteger, nullable=True),
    Column("started_ms", BigInteger, nullable=True),
    Column("shipped_ms", BigInteger, nullable=True),
    Column("cancelled_ms", BigInteger, nullable=True),
    PrimaryKeyConstraint("snapshot_id", "simulation_id", "order_id"),
    schema=ANALYTICS,
)

analytics_transfer_facts = Table(
    "transfer_facts",
    metadata,
    _snapshot_fk(),
    Column("simulation_id", UUID(as_uuid=True), nullable=False),
    Column("transfer_id", Text, nullable=False),
    Column("lane_id", Text, nullable=True),
    Column("from_site_id", Text, nullable=True),
    Column("to_site_id", Text, nullable=True),
    Column("pallets", BigInteger, nullable=True),
    Column("status", Text, nullable=False),
    Column("planned_ms", BigInteger, nullable=True),
    Column("dispatched_ms", BigInteger, nullable=True),
    Column("delivered_ms", BigInteger, nullable=True),
    Column("cancelled_ms", BigInteger, nullable=True),
    PrimaryKeyConstraint("snapshot_id", "simulation_id", "transfer_id"),
    schema=ANALYTICS,
)

analytics_quality_checks = Table(
    "quality_checks",
    metadata,
    _snapshot_fk(),
    Column("check_name", Text, nullable=False),
    Column("kind", Text, nullable=False),
    Column("value", BigInteger, nullable=False),
    PrimaryKeyConstraint("snapshot_id", "check_name"),
    schema=ANALYTICS,
)

# ---------------------------------------------------------------------------------------------
# Digital twin proposals (Phase 6, DEC-039..041)

PROPOSAL_STATUSES = (
    "generated",
    "validated",
    "not_actionable",
    "invalid",
    "approved",
    "rejected",
    "executing",
    "applied",
    "failed",
    "expired",
    "superseded",
)

twin_proposals = Table(
    "proposals",
    metadata,
    Column("proposal_id", UUID(as_uuid=True), nullable=False),
    # Deterministic id of the evaluation (same inputs, same id): creating it twice is idempotent.
    Column("evaluation_id", UUID(as_uuid=True), nullable=False),
    Column("kind", Text, nullable=False),
    Column("strategy_id", Text, nullable=False),
    Column("strategy_version", Text, nullable=False),
    Column("status", Text, nullable=False),
    # Optimistic concurrency: +1 on every status change.
    Column("version", Integer, nullable=False, server_default=text("1")),
    Column("simulation_id", UUID(as_uuid=True), nullable=False),
    Column("source_tick", BigInteger, nullable=False),
    # Simulated business time of the source state (not wall clock).
    Column("source_business_time", DateTime(timezone=True), nullable=False),
    Column("source_state_hash", Text, nullable=False),
    Column("config_hash", Text, nullable=False),
    Column("fleet_fingerprint", Text, nullable=False),
    Column("objective_metric", Text, nullable=False),
    Column("recommended_candidate_id", Text, nullable=True),
    # The evaluation as stored: baseline, candidates with server-computed deltas, explanation.
    Column("evaluation", JSONB, nullable=False),
    # Server-side validation results and the engine commands an execution submits.
    Column("validation", JSONB, nullable=False),
    Column("commands", JSONB, nullable=False),
    # The frozen input snapshot {config, state, state_hash}: lets anyone re-run the evaluation.
    Column("input_snapshot", JSONB, nullable=False),
    Column("created_by", Text, nullable=False),
    wall_clock("created_at"),
    wall_clock("updated_at"),
    Column("decided_by", Text, nullable=True),
    wall_clock("decided_at", nullable=True),
    Column("decision_note", Text, nullable=True),
    Column("executed_tick", BigInteger, nullable=True),
    PrimaryKeyConstraint("proposal_id"),
    UniqueConstraint("evaluation_id"),
    CheckConstraint(
        "status IN (" + ", ".join(f"'{x}'" for x in PROPOSAL_STATUSES) + ")",
        name="status_known",
    ),
    CheckConstraint("kind IN ('optimization', 'what_if')", name="kind_known"),
    CheckConstraint("version >= 1", name="version_positive"),
    Index(None, "simulation_id", "created_at"),
    Index(None, "created_at", "proposal_id"),
    schema=TWIN,
)

twin_proposal_events = Table(
    "proposal_events",
    metadata,
    Column("event_id", BigInteger, Identity(always=True), nullable=False),
    Column(
        "proposal_id",
        UUID(as_uuid=True),
        ForeignKey(f"{TWIN}.proposals.proposal_id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("action", Text, nullable=False),
    Column("from_status", Text, nullable=True),
    Column("to_status", Text, nullable=False),
    Column("actor", Text, nullable=False),
    Column("note", Text, nullable=True),
    Column("details", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    wall_clock("recorded_at"),
    PrimaryKeyConstraint("event_id"),
    Index(None, "proposal_id", "event_id"),
    schema=TWIN,
)

twin_explanations = Table(
    "explanations",
    metadata,
    Column("explanation_id", UUID(as_uuid=True), nullable=False),
    Column(
        "proposal_id",
        UUID(as_uuid=True),
        ForeignKey(f"{TWIN}.proposals.proposal_id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("status", Text, nullable=False),
    Column("provider", Text, nullable=False),
    Column("model", Text, nullable=False),
    Column("prompt_version", Text, nullable=False),
    Column("content", JSONB, nullable=True),
    Column("error_code", Text, nullable=True),
    Column("error_message", Text, nullable=True),
    Column("latency_ms", Integer, nullable=False),
    Column("input_tokens", Integer, nullable=True),
    Column("output_tokens", Integer, nullable=True),
    wall_clock("created_at"),
    PrimaryKeyConstraint("explanation_id"),
    CheckConstraint("status IN ('ok', 'failed')", name="status_known"),
    Index(None, "proposal_id", "created_at"),
    schema=TWIN,
)

__all__ = [
    "aggregate_versions",
    "analytics_metric_buckets",
    "analytics_order_facts",
    "analytics_quality_checks",
    "analytics_runs",
    "analytics_snapshots",
    "analytics_task_facts",
    "analytics_transfer_facts",
    "bronze_objects",
    "command_log",
    "consumer_events",
    "data_quality_issues",
    "dead_letters",
    "domain_events",
    "heartbeats",
    "ingest_batches",
    "metadata",
    "outbox",
    "reconciliation_reports",
    "simulation_runs",
    "twin_explanations",
    "twin_proposal_events",
    "twin_proposals",
]
