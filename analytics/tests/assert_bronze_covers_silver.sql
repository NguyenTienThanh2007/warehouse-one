-- Silver plus rejected events account for every distinct event_id in bronze.
select bronze_ids, silver_ids, rejected_ids
from (
    select
        (select count(distinct event_id) from {{ ref('stg_bronze_events') }}) as bronze_ids,
        (select count(*) from {{ ref('silver_events') }}) as silver_ids,
        (select count(*) from {{ ref('silver_rejected_events') }}) as rejected_ids
)
where bronze_ids <> silver_ids + rejected_ids
