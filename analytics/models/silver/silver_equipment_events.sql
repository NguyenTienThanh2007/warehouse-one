{{ config(location=lake_path('silver', 'equipment_events')) }}
-- equipment.status_changed.
select
    event_id,
    simulation_id,
    "sequence",
    occurred_at,
    event_date,
    simulation_time_ms,
    {{ p_text('equipment_id') }} as equipment_id,
    {{ p_text('from') }} as from_status,
    {{ p_text('to') }} as to_status,
    {{ p_text('node_id') }} as node_id,
    {{ p_text('task_id') }} as task_id,
    {{ p_int('battery_permille') }} as battery_permille
from {{ ref('silver_events') }}
where event_type = 'equipment.status_changed'
