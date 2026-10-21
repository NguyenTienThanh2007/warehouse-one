"""Durable event store, transactional outbox and pipeline state (Phase 3).

Revision ID: 0002_event_store
Revises: 0001_baseline
Create Date: 2026-10-21

operations.*: simulation runs, command log, append-only domain events, outbox, ingest batches.
pipeline.*: consumer dedup and version state, data-quality issues, dead letters, bronze manifest,
heartbeats, reconciliation reports. Generated from warehouse_api.store.tables, then reviewed; the
append-only triggers are hand-written.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_event_store"
down_revision: str | None = "0001_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


APPEND_ONLY = """
CREATE FUNCTION operations.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;
"""


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS pipeline")
    op.create_table(
        "simulation_runs",
        sa.Column("simulation_id", sa.UUID(), nullable=False),
        sa.Column("scenario_id", sa.Text(), nullable=True),
        sa.Column("seed", sa.Text(), nullable=False),
        sa.Column("engine_version", sa.Text(), nullable=False),
        sa.Column("tick_ms", sa.Integer(), nullable=False),
        sa.Column("epoch", sa.DateTime(timezone=True), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("config_sha256", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column(
            "registered_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_sequence", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "last_simulation_time_ms", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("through_tick", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("event_count", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("command_count", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("relay_owner", sa.Text(), nullable=True),
        sa.Column("relay_lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("relay_next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("relay_failures", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("relay_last_error", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "source IN ('web', 'recorder', 'test')", name=op.f("ck_simulation_runs_source_known")
        ),
        sa.CheckConstraint("tick_ms > 0", name=op.f("ck_simulation_runs_tick_ms_positive")),
        sa.PrimaryKeyConstraint("simulation_id", name=op.f("pk_simulation_runs")),
        schema="operations",
    )
    op.create_table(
        "aggregate_versions",
        sa.Column("consumer_group", sa.Text(), nullable=False),
        sa.Column("simulation_id", sa.UUID(), nullable=False),
        sa.Column("aggregate_type", sa.Text(), nullable=False),
        sa.Column("aggregate_id", sa.Text(), nullable=False),
        sa.Column("last_version", sa.BigInteger(), nullable=False),
        sa.Column("last_event_id", sa.UUID(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "consumer_group",
            "simulation_id",
            "aggregate_type",
            "aggregate_id",
            name=op.f("pk_aggregate_versions"),
        ),
        schema="pipeline",
    )
    op.create_table(
        "bronze_objects",
        sa.Column("object_key", sa.Text(), nullable=False),
        sa.Column("consumer_group", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("kafka_topic", sa.Text(), nullable=True),
        sa.Column("kafka_partition", sa.Integer(), nullable=True),
        sa.Column("first_offset", sa.BigInteger(), nullable=True),
        sa.Column("last_offset", sa.BigInteger(), nullable=True),
        sa.Column("event_date", sa.Text(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("record_count", sa.Integer(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("pipeline_version", sa.Text(), nullable=False),
        sa.Column(
            "written_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source IN ('kafka', 'postgres-rebuild')", name=op.f("ck_bronze_objects_source_known")
        ),
        sa.PrimaryKeyConstraint("object_key", name=op.f("pk_bronze_objects")),
        schema="pipeline",
    )
    op.create_table(
        "consumer_events",
        sa.Column("consumer_group", sa.Text(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("simulation_id", sa.UUID(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("aggregate_type", sa.Text(), nullable=False),
        sa.Column("aggregate_id", sa.Text(), nullable=False),
        sa.Column("aggregate_version", sa.BigInteger(), nullable=False),
        sa.Column("envelope_sha256", sa.Text(), nullable=False),
        sa.Column("kafka_topic", sa.Text(), nullable=False),
        sa.Column("kafka_partition", sa.Integer(), nullable=False),
        sa.Column("kafka_offset", sa.BigInteger(), nullable=False),
        sa.Column(
            "first_processed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("delivery_count", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column(
            "last_delivered_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("consumer_group", "event_id", name=op.f("pk_consumer_events")),
        schema="pipeline",
    )
    op.create_index(
        op.f("ix_consumer_events_consumer_group_simulation_id_sequence"),
        "consumer_events",
        ["consumer_group", "simulation_id", "sequence"],
        unique=False,
        schema="pipeline",
    )
    op.create_table(
        "data_quality_issues",
        sa.Column("issue_id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("consumer_group", sa.Text(), nullable=False),
        sa.Column("issue_type", sa.Text(), nullable=False),
        sa.Column("simulation_id", sa.UUID(), nullable=True),
        sa.Column("event_id", sa.UUID(), nullable=True),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("kafka_topic", sa.Text(), nullable=False),
        sa.Column("kafka_partition", sa.Integer(), nullable=False),
        sa.Column("kafka_offset", sa.BigInteger(), nullable=False),
        sa.Column(
            "detected_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("issue_id", name=op.f("pk_data_quality_issues")),
        sa.UniqueConstraint(
            "consumer_group",
            "issue_type",
            "kafka_topic",
            "kafka_partition",
            "kafka_offset",
            name=op.f(
                "uq_data_quality_issues_consumer_group_issue_type_kafka_topic_kafka_partition_kafka_offset"
            ),
        ),
        schema="pipeline",
    )
    op.create_table(
        "dead_letters",
        sa.Column("dead_letter_id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("consumer_group", sa.Text(), nullable=False),
        sa.Column("error_class", sa.Text(), nullable=False),
        sa.Column("error_detail", sa.Text(), nullable=False),
        sa.Column("event_id", sa.Text(), nullable=True),
        sa.Column("simulation_id", sa.Text(), nullable=True),
        sa.Column("source_topic", sa.Text(), nullable=False),
        sa.Column("source_partition", sa.Integer(), nullable=False),
        sa.Column("source_offset", sa.BigInteger(), nullable=False),
        sa.Column("message_key", sa.LargeBinary(), nullable=True),
        sa.Column("message_value", sa.LargeBinary(), nullable=True),
        sa.Column("headers", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("dlq_topic", sa.Text(), nullable=False),
        sa.Column("dlq_partition", sa.Integer(), nullable=True),
        sa.Column("dlq_offset", sa.BigInteger(), nullable=True),
        sa.Column(
            "failed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.PrimaryKeyConstraint("dead_letter_id", name=op.f("pk_dead_letters")),
        sa.UniqueConstraint(
            "consumer_group",
            "source_topic",
            "source_partition",
            "source_offset",
            name=op.f("uq_dead_letters_consumer_group_source_topic_source_partition_source_offset"),
        ),
        schema="pipeline",
    )
    op.create_table(
        "heartbeats",
        sa.Column("component", sa.Text(), nullable=False),
        sa.Column("instance", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "last_beat_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('ok', 'degraded', 'stopping')", name=op.f("ck_heartbeats_status_known")
        ),
        sa.PrimaryKeyConstraint("component", "instance", name=op.f("pk_heartbeats")),
        schema="pipeline",
    )
    op.create_table(
        "reconciliation_reports",
        sa.Column("report_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("scope", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("metrics", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("violations", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("report_object_key", sa.Text(), nullable=True),
        sa.Column("triggered_by", sa.Text(), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "finished_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('passed', 'failed', 'not_settled')",
            name=op.f("ck_reconciliation_reports_status_known"),
        ),
        sa.PrimaryKeyConstraint("report_id", name=op.f("pk_reconciliation_reports")),
        schema="pipeline",
    )
    op.create_table(
        "command_log",
        sa.Column("simulation_id", sa.UUID(), nullable=False),
        sa.Column("command_id", sa.Text(), nullable=False),
        sa.Column("log_index", sa.BigInteger(), nullable=False),
        sa.Column("tick", sa.BigInteger(), nullable=False),
        sa.Column("command_type", sa.Text(), nullable=False),
        sa.Column("command", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("command_sha256", sa.Text(), nullable=False),
        sa.Column("batch_id", sa.UUID(), nullable=False),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("tick >= 1", name=op.f("ck_command_log_tick_positive")),
        sa.ForeignKeyConstraint(
            ["simulation_id"],
            ["operations.simulation_runs.simulation_id"],
            name=op.f("fk_command_log_simulation_id_simulation_runs"),
        ),
        sa.PrimaryKeyConstraint("simulation_id", "command_id", name=op.f("pk_command_log")),
        sa.UniqueConstraint(
            "simulation_id", "log_index", name=op.f("uq_command_log_simulation_id_log_index")
        ),
        schema="operations",
    )
    op.create_table(
        "domain_events",
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("simulation_id", sa.UUID(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("aggregate_type", sa.Text(), nullable=False),
        sa.Column("aggregate_id", sa.Text(), nullable=False),
        sa.Column("aggregate_version", sa.BigInteger(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("simulation_time_ms", sa.BigInteger(), nullable=False),
        sa.Column("correlation_id", sa.Text(), nullable=False),
        sa.Column("causation_id", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("envelope", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("envelope_sha256", sa.Text(), nullable=False),
        sa.Column("batch_id", sa.UUID(), nullable=False),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "aggregate_version >= 1", name=op.f("ck_domain_events_version_positive")
        ),
        sa.CheckConstraint("sequence >= 1", name=op.f("ck_domain_events_sequence_positive")),
        sa.ForeignKeyConstraint(
            ["simulation_id"],
            ["operations.simulation_runs.simulation_id"],
            name=op.f("fk_domain_events_simulation_id_simulation_runs"),
        ),
        sa.PrimaryKeyConstraint("event_id", name=op.f("pk_domain_events")),
        sa.UniqueConstraint(
            "simulation_id",
            "aggregate_type",
            "aggregate_id",
            "aggregate_version",
            name=op.f(
                "uq_domain_events_simulation_id_aggregate_type_aggregate_id_aggregate_version"
            ),
        ),
        sa.UniqueConstraint(
            "simulation_id", "sequence", name=op.f("uq_domain_events_simulation_id_sequence")
        ),
        schema="operations",
    )
    op.create_index(
        op.f("ix_domain_events_occurred_at"),
        "domain_events",
        ["occurred_at"],
        unique=False,
        schema="operations",
    )
    op.create_table(
        "ingest_batches",
        sa.Column("batch_id", sa.UUID(), nullable=False),
        sa.Column("simulation_id", sa.UUID(), nullable=False),
        sa.Column("request_sha256", sa.Text(), nullable=False),
        sa.Column("first_sequence", sa.BigInteger(), nullable=True),
        sa.Column("last_sequence", sa.BigInteger(), nullable=True),
        sa.Column("through_tick", sa.BigInteger(), nullable=False),
        sa.Column("accepted_events", sa.Integer(), nullable=False),
        sa.Column("duplicate_events", sa.Integer(), nullable=False),
        sa.Column("accepted_commands", sa.Integer(), nullable=False),
        sa.Column("duplicate_commands", sa.Integer(), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["simulation_id"],
            ["operations.simulation_runs.simulation_id"],
            name=op.f("fk_ingest_batches_simulation_id_simulation_runs"),
        ),
        sa.PrimaryKeyConstraint("batch_id", name=op.f("pk_ingest_batches")),
        schema="operations",
    )
    op.create_index(
        op.f("ix_ingest_batches_simulation_id"),
        "ingest_batches",
        ["simulation_id"],
        unique=False,
        schema="operations",
    )
    op.create_table(
        "outbox",
        sa.Column("outbox_id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("simulation_id", sa.UUID(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("topic", sa.Text(), nullable=False),
        sa.Column("message_key", sa.Text(), nullable=False),
        sa.Column("message_value", sa.LargeBinary(), nullable=False),
        sa.Column("headers", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("kafka_partition", sa.Integer(), nullable=True),
        sa.Column("kafka_offset", sa.BigInteger(), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["operations.domain_events.event_id"],
            name=op.f("fk_outbox_event_id_domain_events"),
        ),
        sa.PrimaryKeyConstraint("outbox_id", name=op.f("pk_outbox")),
        sa.UniqueConstraint("event_id", name=op.f("uq_outbox_event_id")),
        schema="operations",
    )
    op.create_index(
        "ix_outbox_unpublished",
        "outbox",
        ["simulation_id", "sequence"],
        unique=False,
        schema="operations",
        postgresql_where=sa.text("published_at IS NULL"),
    )
    # Events and commands are facts: rows may be inserted, never changed or removed.
    op.execute(APPEND_ONLY)
    for table in ("domain_events", "command_log"):
        op.execute(
            f"CREATE TRIGGER {table}_append_only BEFORE UPDATE OR DELETE ON operations.{table} "
            "FOR EACH ROW EXECUTE FUNCTION operations.reject_mutation()"
        )


def downgrade() -> None:
    for table in ("domain_events", "command_log"):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_append_only ON operations.{table}")
    op.execute("DROP FUNCTION IF EXISTS operations.reject_mutation()")
    op.drop_index(
        "ix_outbox_unpublished",
        table_name="outbox",
        schema="operations",
        postgresql_where=sa.text("published_at IS NULL"),
    )
    op.drop_table("outbox", schema="operations")
    op.drop_index(
        op.f("ix_ingest_batches_simulation_id"), table_name="ingest_batches", schema="operations"
    )
    op.drop_table("ingest_batches", schema="operations")
    op.drop_index(
        op.f("ix_domain_events_occurred_at"), table_name="domain_events", schema="operations"
    )
    op.drop_table("domain_events", schema="operations")
    op.drop_table("command_log", schema="operations")
    op.drop_table("reconciliation_reports", schema="pipeline")
    op.drop_table("heartbeats", schema="pipeline")
    op.drop_table("dead_letters", schema="pipeline")
    op.drop_table("data_quality_issues", schema="pipeline")
    op.drop_index(
        op.f("ix_consumer_events_consumer_group_simulation_id_sequence"),
        table_name="consumer_events",
        schema="pipeline",
    )
    op.drop_table("consumer_events", schema="pipeline")
    op.drop_table("bronze_objects", schema="pipeline")
    op.drop_table("aggregate_versions", schema="pipeline")
    op.drop_table("simulation_runs", schema="operations")
    op.execute("DROP SCHEMA IF EXISTS pipeline")
