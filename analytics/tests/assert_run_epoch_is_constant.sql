-- occurred_at - simulation_time_ms is the same instant for every event of a run (the run's clock
-- origin), so business time can be derived from simulated milliseconds without a time zone.
select simulation_id, run_epoch_spread_ms
from {{ ref('gold_simulation_activity') }}
where run_epoch_spread_ms <> 0
