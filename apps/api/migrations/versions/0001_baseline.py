"""Baseline: dedicated schema for WAREHOUSE ONE operational tables.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-10-20

Phase 0 establishes the migration chain only. Operational tables (simulation runs, transactional
outbox, durable event log) are introduced in Phase 3 when their behaviour is implemented and tested.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001_baseline"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS operations")


def downgrade() -> None:
    # RESTRICT (default): refuses to drop the schema if later migrations left tables in it.
    op.execute("DROP SCHEMA IF EXISTS operations")
