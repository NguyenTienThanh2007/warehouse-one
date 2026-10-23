{{ config(location=lake_path('gold', 'simulation_activity')) }}
-- Per run: extent, volume and outcomes, from deduplicated events.
with e as (select * from {{ ref('silver_events') }})

select
    simulation_id,
    count(*) as events,
    count(distinct event_type) as event_types,
    min("sequence") as first_sequence,
    max("sequence") as last_sequence,
    max("sequence") - min("sequence") + 1 - count(*) as missing_sequences,
    min(occurred_at) as first_occurred_at,
    max(occurred_at) as last_occurred_at,
    max(simulation_time_ms) - min(simulation_time_ms) as simulated_span_ms,
    -- The run's simulated clock origin (UTC epoch ms): occurred_at = run_epoch_ms + simulation_time_ms.
    min(epoch_ms(occurred_at) - simulation_time_ms) as run_epoch_ms,
    max(epoch_ms(occurred_at) - simulation_time_ms) - min(epoch_ms(occurred_at) - simulation_time_ms)
        as run_epoch_spread_ms,
    max(simulation_time_ms) as last_simulation_time_ms,
    count(*) filter (where event_type = 'task.completed') as tasks_completed,
    count(*) filter (where event_type = 'order.status_changed'
        and json_extract_string(payload_json, '$.to') = 'shipped') as orders_shipped,
    count(*) filter (where event_type = 'truck.status_changed'
        and json_extract_string(payload_json, '$.to') = 'departed') as trucks_departed,
    sum(delivery_copies) - count(*) as redelivered_copies
from e
group by simulation_id
