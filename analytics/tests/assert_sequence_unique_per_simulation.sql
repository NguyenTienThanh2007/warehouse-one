-- A run's sequence numbers identify its events: one event per (simulation_id, sequence).
select simulation_id, "sequence", count(*) as events
from {{ ref('silver_events') }}
group by simulation_id, "sequence"
having count(*) > 1
