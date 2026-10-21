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
    count(*) filter (where event_type = 'task.completed') as tasks_completed,
    count(*) filter (where event_type = 'order.status_changed'
        and json_extract_string(payload_json, '$.to') = 'shipped') as orders_shipped,
    count(*) filter (where event_type = 'truck.status_changed'
        and json_extract_string(payload_json, '$.to') = 'departed') as trucks_departed,
    sum(delivery_copies) - count(*) as redelivered_copies
from e
group by simulation_id
