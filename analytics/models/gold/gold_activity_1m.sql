{{ config(location=lake_path('gold', 'activity_1m')) }}
-- Distinct events per run, event type and minute of simulated time. Buckets are offsets from the
-- run's simulated clock origin (bucket_ms = floor(simulation_time_ms / 1 min) * 1 min),
-- so they never depend on a time zone or on wall-clock ingestion time.
select
    simulation_id,
    (simulation_time_ms // 60000) * 60000 as bucket_ms,
    event_type,
    count(*) as events
from {{ ref('silver_events') }}
group by simulation_id, bucket_ms, event_type
