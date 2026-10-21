{{ config(location=lake_path('silver', 'order_events')) }}
-- order.status_changed; lines kept as JSON, total pallets summed from them.
select
    event_id,
    simulation_id,
    "sequence",
    occurred_at,
    event_date,
    simulation_time_ms,
    {{ p_text('order_id') }} as order_id,
    {{ p_text('from') }} as from_status,
    {{ p_text('to') }} as to_status,
    {{ p_text('truck_id') }} as truck_id,
    json_extract(payload_json, '$.lines') as lines_json,
    (
        select coalesce(sum(cast(l ->> 'quantity' as bigint)), 0)
        from (select unnest(json_extract(payload_json, '$.lines[*]')) as l)
    ) as total_pallets
from {{ ref('silver_events') }}
where event_type = 'order.status_changed'
