{{ config(location=lake_path('gold', 'data_quality')) }}
-- Data-quality measurements across the lake, one row per check (value 0 = clean).
with silver as (select * from {{ ref('silver_events') }}),
rejected as (select * from {{ ref('silver_rejected_events') }}),
bronze as (select * from {{ ref('stg_bronze_events') }}),
version_steps as (
    select
        aggregate_version - lag(aggregate_version) over (
            partition by simulation_id, aggregate_type, aggregate_id order by "sequence"
        ) as step
    from silver
),
activity as (select * from {{ ref('gold_simulation_activity') }})

select 'bronze_rows' as check_name, cast(count(*) as bigint) as value, 'info' as kind from bronze
union all
select 'distinct_events_in_bronze', count(distinct event_id), 'info' from bronze
union all
select 'silver_events', count(*), 'info' from silver
union all
select 'redelivered_copies', cast(coalesce(sum(delivery_copies) - count(*), 0) as bigint), 'info'
from silver
union all
select 'conflicting_copies', count(*), 'error' from rejected where reason = 'conflicting_copies'
union all
select 'unsupported_schema_versions', count(*), 'error' from rejected
where reason = 'unsupported_schema_version'
union all
select 'aggregate_version_steps_not_one', count(*), 'error' from version_steps where step <> 1
union all
select 'runs_with_missing_sequences', count(*), 'error' from activity where missing_sequences > 0
