{{ config(location=lake_path('gold', 'task_lifecycle')) }}
-- One row per task: created → assigned → completed / cancelled, in simulated time.
with t as (select * from {{ ref('silver_task_events') }})

select
    simulation_id,
    task_id,
    any_value(task_type) filter (where event_type = 'task.created') as task_type,
    any_value(pallet_id) filter (where event_type = 'task.created') as pallet_id,
    any_value(order_id) filter (where event_type = 'task.created') as order_id,
    any_value(equipment_id) filter (where event_type = 'task.assigned') as equipment_id,
    min(simulation_time_ms) filter (where event_type = 'task.created') as created_ms,
    min(simulation_time_ms) filter (where event_type = 'task.assigned') as assigned_ms,
    min(simulation_time_ms) filter (where event_type = 'task.completed') as completed_ms,
    min(simulation_time_ms) filter (where event_type = 'task.cancelled') as cancelled_ms,
    any_value(duration_ticks) filter (where event_type = 'task.completed') as duration_ticks,
    any_value(route_length_mm) filter (where event_type = 'task.assigned') as route_length_mm,
    case
        when count(*) filter (where event_type = 'task.completed') > 0 then 'completed'
        when count(*) filter (where event_type = 'task.cancelled') > 0 then 'cancelled'
        when count(*) filter (where event_type = 'task.assigned') > 0 then 'assigned'
        else 'pending'
    end as status,
    min(simulation_time_ms) filter (where event_type = 'task.assigned')
        - min(simulation_time_ms) filter (where event_type = 'task.created') as wait_ms,
    min(simulation_time_ms) filter (where event_type = 'task.completed')
        - min(simulation_time_ms) filter (where event_type = 'task.assigned') as service_ms
from t
group by simulation_id, task_id
