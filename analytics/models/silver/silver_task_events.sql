{{ config(location=lake_path('silver', 'task_events')) }}
-- task.created / assigned / completed / cancelled.
select
    event_id,
    simulation_id,
    "sequence",
    occurred_at,
    event_date,
    simulation_time_ms,
    event_type,
    {{ p_text('task_id') }} as task_id,
    {{ p_text('task_type') }} as task_type,
    {{ p_text('pallet_id') }} as pallet_id,
    {{ p_text('sku') }} as sku,
    {{ p_text('order_id') }} as order_id,
    {{ p_text('truck_id') }} as truck_id,
    {{ p_text('equipment_id') }} as equipment_id,
    {{ p_int('route_length_mm') }} as route_length_mm,
    {{ p_int('duration_ticks') }} as duration_ticks,
    {{ p_text('reason') }} as reason
from {{ ref('silver_events') }}
where event_type like 'task.%'
