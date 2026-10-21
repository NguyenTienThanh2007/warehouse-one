"""Published analytics snapshots served to the dashboard (Phase 4).

Revision ID: 0003_analytics_serving
Revises: 0002_event_store
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_analytics_serving"
down_revision: str | None = "0002_event_store"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS analytics")
    op.create_table(
        "snapshots",
        sa.Column("snapshot_id", sa.UUID(), nullable=False),
        sa.Column(
            "published_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("source_as_of", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reconciliation_report_id", sa.UUID(), nullable=False),
        sa.Column("reconciliation_status", sa.Text(), nullable=False),
        sa.Column("model_counts", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.CheckConstraint(
            "reconciliation_status = 'passed'",
            name=op.f("ck_snapshots_reconciliation_passed"),
        ),
        sa.ForeignKeyConstraint(
            ["reconciliation_report_id"],
            ["pipeline.reconciliation_reports.report_id"],
            name=op.f("fk_snapshots_reconciliation_report_id_reconciliation_reports"),
        ),
        sa.PrimaryKeyConstraint("snapshot_id", name=op.f("pk_snapshots")),
        schema="analytics",
    )
    op.create_table(
        "model_rows",
        sa.Column("snapshot_id", sa.UUID(), nullable=False),
        sa.Column("model_name", sa.Text(), nullable=False),
        sa.Column("row_index", sa.Integer(), nullable=False),
        sa.Column("row_data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["snapshot_id"],
            ["analytics.snapshots.snapshot_id"],
            name=op.f("fk_model_rows_snapshot_id_snapshots"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "snapshot_id", "model_name", "row_index", name=op.f("pk_model_rows")
        ),
        schema="analytics",
    )
    op.create_index(
        op.f("ix_model_rows_snapshot_id_model_name"),
        "model_rows",
        ["snapshot_id", "model_name"],
        unique=False,
        schema="analytics",
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_model_rows_snapshot_id_model_name"), table_name="model_rows", schema="analytics"
    )
    op.drop_table("model_rows", schema="analytics")
    op.drop_table("snapshots", schema="analytics")
    op.execute("DROP SCHEMA IF EXISTS analytics")
