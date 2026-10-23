"""Analytics (Phase 4) without a database: the window rules of the read API and the publisher's
reading of gold, against a hand-computed data set (tests/analytics_gold.py)."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tests.analytics_gold import EPOCH, EVENTS, INGESTED, RUN, write_gold
from warehouse_api.analytics.service import MAX_POINTS, STORAGE_BUCKET_MS, resolve_window
from warehouse_api.api.errors import ApiError
from warehouse_pipeline import analytics

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")

MIN = 60_000


def at(ms: int) -> datetime:
    return EPOCH + timedelta(milliseconds=ms)


class TestWindow:
    def test_default_is_the_whole_run_including_the_last_events_minute(self) -> None:
        b = resolve_window(EPOCH, 100, 30 * MIN + 5, None, None)
        assert (b.from_ms, b.to_ms, b.bucket_ms, b.clamped) == (0, 31 * MIN, MIN, False)

    def test_window_is_half_open_and_snapped_outwards(self) -> None:
        b = resolve_window(EPOCH, 0, 30 * MIN, at(10 * MIN + 5), at(20 * MIN - 5))
        assert (b.from_ms, b.to_ms) == (10 * MIN, 20 * MIN)

    def test_partial_overlap_is_clamped_and_flagged(self) -> None:
        b = resolve_window(EPOCH, 0, 30 * MIN, at(-60 * MIN), at(5 * MIN))
        assert (b.from_ms, b.to_ms, b.clamped) == (0, 5 * MIN, True)

    @pytest.mark.parametrize(
        ("lo", "hi", "code"),
        [
            (10 * MIN, 10 * MIN, "INVALID_WINDOW"),
            (20 * MIN, 10 * MIN, "INVALID_WINDOW"),
            (-120 * MIN, -60 * MIN, "WINDOW_OUT_OF_RANGE"),
            (31 * MIN, 40 * MIN, "WINDOW_OUT_OF_RANGE"),
            (0, 32 * 24 * 60 * MIN, "WINDOW_TOO_LARGE"),
        ],
    )
    def test_invalid_windows_are_rejected_with_a_code(self, lo: int, hi: int, code: str) -> None:
        with pytest.raises(ApiError) as err:
            resolve_window(EPOCH, 0, 30 * MIN, at(lo), at(hi))
        assert (err.value.status, err.value.code) == (422, code)

    def test_naive_bounds_are_rejected(self) -> None:
        with pytest.raises(ApiError) as err:
            resolve_window(EPOCH, 0, 30 * MIN, datetime(2026, 1, 5, 6, 5), None)
        assert err.value.code == "INVALID_WINDOW"

    @pytest.mark.parametrize(
        ("span_min", "resolution_min"),
        [(30, 1), (240, 1), (241, 5), (24 * 60, 15), (7 * 24 * 60, 60), (31 * 24 * 60, 360)],
    )
    def test_resolution_keeps_series_within_the_point_budget(
        self, span_min: int, resolution_min: int
    ) -> None:
        b = resolve_window(EPOCH, 0, span_min * MIN - 1, None, None)
        assert b.bucket_ms == resolution_min * MIN
        assert (b.to_ms - b.from_ms) // b.bucket_ms <= MAX_POINTS

    def test_storage_buckets_match_the_publisher(self) -> None:
        assert STORAGE_BUCKET_MS == analytics.BUCKET_MS


class TestReadGold:
    def test_reads_every_model_with_hand_computed_values(self, tmp_path: Path) -> None:
        write_gold(tmp_path)
        data = analytics.read_gold(analytics.local_gold(tmp_path, built_at=INGESTED))
        assert [r["simulation_id"] for r in data.runs] == [RUN]
        run = data.runs[0]
        assert (run["events"], run["first_simulation_time_ms"]) == (EVENTS, 0)
        events = {
            (b["dimension"], b["bucket_ms"]): b["value"]
            for b in data.buckets
            if b["metric"] == "events"
        }
        assert sum(events.values()) == EVENTS
        assert events[("pallet.removed", 28 * MIN)] == 4
        flows = {
            (b["metric"], b["dimension"]): b["value"]
            for b in data.buckets
            if b["metric"].startswith("pallets_")
        }
        assert flows == {
            ("pallets_created", "receive"): 1,
            ("pallets_created", "inbound_truck"): 1,
            ("pallets_moved", "slot>equipment"): 1,
            ("pallets_removed", "shipped"): 4,
        }
        # Pallet flows land in the minute bucket of their simulated time (removals at 28 min).
        removed = [b for b in data.buckets if b["metric"] == "pallets_removed"]
        assert {b["bucket_ms"] for b in removed} == {28 * MIN}
        units = {
            b["dimension"]: b["value"] for b in data.buckets if b["metric"] == "inventory_units"
        }
        assert units == {"receipt": 6, "adjustment": -1}
        assert [t["task_id"] for t in data.tasks] == ["t1", "t2", "t3", "t4"]
        assert [o["status"] for o in data.orders] == ["shipped", "open"]
        assert [x["transfer_id"] for x in data.transfers] == ["x1", "x2"]
        assert {q["check_name"] for q in data.quality} >= {"conflicting_copies", "silver_events"}
        assert data.source_watermark == INGESTED

    def test_skips_dbt_placeholder_rows_of_empty_models(self, tmp_path: Path) -> None:
        write_gold(tmp_path, placeholder_transfers=True)
        data = analytics.read_gold(analytics.local_gold(tmp_path, built_at=datetime.now(UTC)))
        assert data.transfers == []
