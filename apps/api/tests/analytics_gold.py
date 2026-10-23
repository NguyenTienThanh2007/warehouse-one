# ruff: noqa: S608 - SQL here is built from module constants only, to write Parquet test files.
"""A small, hand-computed gold data set (the shapes dbt writes) for analytics tests.

One run, `RUN`, whose simulated clock starts at 2026-01-05T06:00:00Z and spans 30 minutes:

| task | type     | created | assigned | completed | cancelled |
|------|----------|---------|----------|-----------|-----------|
| t1   | relocate |   0 s   |   60 s   |   300 s   |           |
| t2   | pick     | 120 s   |  180 s   |  1500 s   |           |
| t3   | putaway  | 600 s   |  700 s   |           |           |
| t4   | relocate | 900 s   |          |           |  1000 s   |

Orders: o1 opened 60 s, shipped 1700 s (4 pallets); o2 opened 1200 s, still open.
Transfers: x1 lane-a 10 pallets planned 100 s delivered 1600 s; x2 operator request (no lane)
5 pallets planned 1000 s delivered 1650 s.
Events per minute bucket and pallet flows are listed in `write_gold`.
"""

from datetime import UTC, datetime
from pathlib import Path

import duckdb

RUN = "11111111-2222-8333-8444-555555555555"
EPOCH = datetime(2026, 1, 5, 6, 0, tzinfo=UTC)
EPOCH_MS = int(EPOCH.timestamp() * 1000)
INGESTED = datetime(2026, 10, 23, 12, 0, tzinfo=UTC)

# (bucket minute, event type, events)
ACTIVITY = [
    (0, "task.created", 1),
    (0, "pallet.created", 2),
    (1, "task.assigned", 1),
    (2, "task.created", 1),
    (5, "task.completed", 1),
    (10, "task.created", 1),
    (11, "task.assigned", 1),
    (15, "task.created", 1),
    (16, "task.cancelled", 1),
    (25, "task.completed", 1),
    (28, "pallet.removed", 4),
]
EVENTS = sum(n for _, _, n in ACTIVITY)  # 15


def _copy(con: duckdb.DuckDBPyConnection, sql: str, path: Path) -> None:
    con.execute(f"COPY ({sql}) TO '{path}' (FORMAT parquet)")


def write_gold(directory: Path, *, placeholder_transfers: bool = False) -> None:
    """Write every gold model `publish` reads (and `silver_events`) into `directory`."""
    con = duckdb.connect()
    d = directory
    _copy(
        con,
        f"""select '{RUN}'::uuid as simulation_id, {EVENTS}::bigint as events,
            7::bigint as event_types, 1::bigint as first_sequence,
            {EVENTS}::bigint as last_sequence,
            0::bigint as missing_sequences, 2::bigint as redelivered_copies,
            {EPOCH_MS}::bigint as run_epoch_ms, 1800000::bigint as simulated_span_ms,
            1800000::bigint as last_simulation_time_ms""",
        d / "simulation_activity.parquet",
    )
    values = ", ".join(f"('{RUN}'::uuid, {m * 60000}, '{t}', {n})" for m, t, n in ACTIVITY)
    _copy(
        con,
        f"select col0 as simulation_id, col1::bigint as bucket_ms, col2 as event_type,"
        f" col3::bigint as events from (values {values})",
        d / "activity_1m.parquet",
    )
    at = lambda s: f"to_timestamp({(EPOCH_MS + s * 1000) / 1000})"  # noqa: E731
    _copy(
        con,
        f"""select '{RUN}'::uuid as simulation_id, * from (values
              ({at(0)}, 'created', null, null, 'receive'),
              ({at(30)}, 'created', null, null, 'inbound_truck'),
              ({at(300)}, 'moved', 'slot', 'equipment', null),
              ({at(1680)}, 'removed', null, null, 'shipped'),
              ({at(1690)}, 'removed', null, null, 'shipped'),
              ({at(1700)}, 'removed', null, null, 'shipped'),
              ({at(1710)}, 'removed', null, null, 'shipped')
            ) as t(occurred_at, flow, from_kind, to_kind, cause_or_reason)""",
        d / "pallet_flows.parquet",
    )
    _copy(
        con,
        f"""select '{RUN}'::uuid as simulation_id, * from (values
              ({at(0)}, 'receipt', 6::bigint), ({at(400)}, 'adjustment', -1::bigint)
            ) as t(occurred_at, movement_type, quantity_change)""",
        d / "inventory_movements.parquet",
    )
    _copy(
        con,
        f"""select '{RUN}'::uuid as simulation_id, * from (values
              ('t1', 'relocate', 'completed', 0::bigint, 60000::bigint, 300000::bigint,
               null::bigint),
              ('t2', 'pick', 'completed', 120000, 180000, 1500000, null),
              ('t3', 'putaway', 'assigned', 600000, 700000, null, null),
              ('t4', 'relocate', 'cancelled', 900000, null, null, 1000000)
            ) as t(task_id, task_type, status, created_ms, assigned_ms, completed_ms,
                   cancelled_ms)""",
        d / "task_lifecycle.parquet",
    )
    _copy(
        con,
        f"""select '{RUN}'::uuid as simulation_id, * from (values
              ('o1', 'shipped', 4::bigint, 60000::bigint, 90000::bigint, 1700000::bigint,
               null::bigint),
              ('o2', 'open', 2, 1200000, null, null, null)
            ) as t(order_id, status, ordered_pallets, opened_ms, started_ms, shipped_ms,
                   cancelled_ms)""",
        d / "order_fulfilment.parquet",
    )
    if placeholder_transfers:
        # What dbt-duckdb writes for an empty external model: one all-NULL row.
        _copy(
            con,
            """select null::uuid as simulation_id, null::varchar as transfer_id,
                null::varchar as lane_id, null::varchar as from_site_id,
                null::varchar as to_site_id,
                null::bigint as pallets, null::varchar as status, null::bigint as planned_ms,
                null::bigint as dispatched_ms, null::bigint as delivered_ms,
                null::bigint as cancelled_ms""",
            d / "transfers.parquet",
        )
    else:
        _copy(
            con,
            f"""select '{RUN}'::uuid as simulation_id, * from (values
                  ('x1', 'lane-a', 'terminal', 'xd', 10::bigint, 'delivered', 100000::bigint,
                   400000::bigint, 1600000::bigint, null::bigint),
                  ('x2', null, 'xd', 'terminal', 5, 'delivered', 1000000, 1100000, 1650000, null)
                ) as t(transfer_id, lane_id, from_site_id, to_site_id, pallets, status,
                       planned_ms, dispatched_ms, delivered_ms, cancelled_ms)""",
            d / "transfers.parquet",
        )
    _copy(
        con,
        """select * from (values ('silver_events', 'info', 15::bigint),
              ('conflicting_copies', 'error', 0::bigint),
              ('redelivered_copies', 'info', 2::bigint)) as t(check_name, kind, value)""",
        d / "data_quality.parquet",
    )
    _copy(
        con,
        f"select to_timestamp({INGESTED.timestamp()}) as first_ingested_at",
        d / "silver_events.parquet",
    )
    con.close()
