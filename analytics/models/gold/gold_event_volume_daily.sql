{{ config(location=lake_path('gold', 'event_volume_daily')) }}
-- Distinct events per simulated business date and event type.
select
    event_date,
    event_type,
    count(*) as events,
    count(distinct simulation_id) as simulations,
    sum(delivery_copies) - count(*) as redelivered_copies
from {{ ref('silver_events') }}
group by event_date, event_type
