{{ config(location=lake_path('silver', 'truck_events')) }}
-- truck.status_changed (from is null when the truck is created).
select
    event_id,
    simulation_id,
    "sequence",
    occurred_at,
    event_date,
    simulation_time_ms,
    {{ p_text('truck_id') }} as truck_id,
    {{ p_text('direction') }} as direction,
    {{ p_text('from') }} as from_status,
    {{ p_text('to') }} as to_status,
    {{ p_text('dock_id') }} as dock_id,
    {{ p_int('pallet_count') }} as pallet_count
from {{ ref('silver_events') }}
where event_type = 'truck.status_changed'
