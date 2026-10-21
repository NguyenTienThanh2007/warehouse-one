-- Within a run, every aggregate's versions advance by exactly 1 in sequence order.
select *
from (
    select
        simulation_id, aggregate_type, aggregate_id, "sequence", aggregate_version,
        aggregate_version - lag(aggregate_version, 1, 0) over (
            partition by simulation_id, aggregate_type, aggregate_id order by "sequence"
        ) as step
    from {{ ref('silver_events') }}
)
where step <> 1
