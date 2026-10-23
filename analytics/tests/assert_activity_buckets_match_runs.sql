-- Every silver event is counted in exactly one one-minute activity bucket of its run.
select a.simulation_id, a.events, b.bucketed
from {{ ref('gold_simulation_activity') }} as a
left join (
    select simulation_id, sum(events) as bucketed
    from {{ ref('gold_activity_1m') }}
    group by simulation_id
) as b using (simulation_id)
where b.bucketed is distinct from a.events
