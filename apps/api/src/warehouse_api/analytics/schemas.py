"""Response schemas of the analytics read API (Phase 4). Read-only; every field is documented in
docs/phases/PHASE_4.md (metrics catalogue).

Two clocks, never mixed:
- **business time** (`business_*`, `bucket_start`, window bounds) is simulated time: the run's
  simulated clock origin plus simulated milliseconds (`time_basis = "simulated"`);
- **wall-clock time** (`generated_at`, `server_time`, `*_recorded_at`, heartbeat times) is when
  the platform did something.
Durations ending in `_ms` are simulated milliseconds.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class _Out(BaseModel):
    model_config = ConfigDict(frozen=True)


class SnapshotMeta(_Out):
    snapshot_id: UUID
    catalogue_version: int
    generated_at: datetime
    gold_built_at: datetime
    reconciliation_status: Literal["passed", "not_required"]
    reconciliation_report_id: UUID | None
    reconciliation_finished_at: datetime | None
    #: Latest wall-clock ingestion time of an event included in the snapshot.
    source_watermark: datetime | None
    source_events: int
    run_count: int
    business_from: datetime | None
    business_to: datetime | None
    time_basis: Literal["simulated"] = "simulated"


class Freshness(_Out):
    age_seconds: float
    stale_after_seconds: int
    is_stale: bool
    #: Events stored in the event log after the snapshot's source watermark (not published yet).
    events_recorded_after: int
    latest_event_recorded_at: datetime | None


class ReconciliationState(_Out):
    report_id: UUID
    status: Literal["passed", "failed", "not_settled"]
    finished_at: datetime
    triggered_by: str


class ComponentHealth(_Out):
    component: str
    instance: str
    status: str
    last_beat_at: datetime
    age_seconds: float
    healthy: bool


class PipelineHealth(_Out):
    healthy: bool
    problems: list[str]
    reconciliation: ReconciliationState | None
    components: list[ComponentHealth]
    outbox_unpublished: int
    dead_letters: int


class AnalyticsStatus(_Out):
    """`empty`: nothing published yet; `degraded`: the pipeline has a problem (the snapshot may be
    behind or wrong to rely on); `stale`: older than the staleness limit; `fresh` otherwise."""

    state: Literal["empty", "fresh", "stale", "degraded"]
    server_time: datetime
    snapshot: SnapshotMeta | None
    freshness: Freshness | None
    pipeline: PipelineHealth


class RunSummary(_Out):
    simulation_id: UUID
    scenario_id: str | None
    run_epoch: datetime
    business_from: datetime
    business_to: datetime
    simulated_span_ms: int
    events: int
    event_types: int
    missing_sequences: int
    redelivered_copies: int


class RunList(_Out):
    snapshot_id: UUID
    generated_at: datetime
    time_basis: Literal["simulated"] = "simulated"
    runs: list[RunSummary]


class Window(_Out):
    business_from: datetime
    business_to: datetime
    from_ms: int
    to_ms: int
    #: Width of one series bucket (simulated ms), chosen so the series has at most 240 points.
    resolution_ms: int
    buckets: int
    #: True when the requested window was cut to the run's extent.
    clamped: bool


class Kpis(_Out):
    events: int
    tasks_created: int
    tasks_completed: int
    tasks_cancelled: int
    task_cycle_p50_ms: int | None
    task_cycle_p90_ms: int | None
    task_wait_p50_ms: int | None
    tasks_completed_per_hour: float | None
    orders_opened: int
    orders_shipped: int
    orders_cancelled: int
    orders_open_at_end: int
    order_lead_p50_ms: int | None
    order_lead_p90_ms: int | None
    pallets_created: int
    pallets_received: int
    pallets_moved: int
    pallets_shipped: int
    pallets_shipped_per_hour: float | None
    transfers_delivered: int
    transfer_pallets_delivered: int
    transfer_lead_p50_ms: int | None


class SeriesPoint(_Out):
    bucket_start: datetime
    #: Bucket start as simulated ms since the run's clock origin.
    offset_ms: int
    events: int
    tasks_created: int
    tasks_completed: int
    orders_shipped: int
    pallets_created: int
    pallets_removed: int


class CountByKey(_Out):
    key: str
    value: int


class TaskTypeBreakdown(_Out):
    task_type: str
    created: int
    completed: int
    cancelled: int
    cycle_p50_ms: int | None
    cycle_p90_ms: int | None


class PalletFlow(_Out):
    flow: Literal["created", "moved", "removed"]
    detail: str
    pallets: int


class LaneBreakdown(_Out):
    lane_id: str
    from_site_id: str | None
    to_site_id: str | None
    delivered: int
    pallets: int
    lead_p50_ms: int | None


class QualityCheck(_Out):
    check_name: str
    kind: str
    value: int


class RunIntegrity(_Out):
    """Whole-run figures (not windowed): gaps and redeliveries seen by the pipeline."""

    events: int
    missing_sequences: int
    redelivered_copies: int


class RunAnalytics(_Out):
    snapshot_id: UUID
    generated_at: datetime
    simulation_id: UUID
    scenario_id: str | None
    time_basis: Literal["simulated"] = "simulated"
    run_business_from: datetime
    run_business_to: datetime
    window: Window
    kpis: Kpis
    series: list[SeriesPoint]
    events_by_type: list[CountByKey]
    tasks_by_type: list[TaskTypeBreakdown]
    pallet_flows: list[PalletFlow]
    inventory_units: list[CountByKey]
    transfers_by_lane: list[LaneBreakdown]
    integrity: RunIntegrity
    #: Lake-wide data-quality checks of the snapshot (not limited to this run).
    quality: list[QualityCheck]
