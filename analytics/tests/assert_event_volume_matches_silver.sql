-- Gold volume counts every silver event exactly once.
select gold_events, silver_events
from (
    select
        (select coalesce(sum(events), 0) from {{ ref('gold_event_volume_daily') }}) as gold_events,
        (select count(*) from {{ ref('silver_events') }}) as silver_events
)
where gold_events <> silver_events
