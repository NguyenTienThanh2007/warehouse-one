-- A transfer is dispatched no earlier than planned and delivered no earlier than dispatched.
select *
from {{ ref('gold_transfers') }}
where dispatched_ms < planned_ms
   or delivered_ms < dispatched_ms
   or (status = 'delivered' and (delivered_ms is null or lead_time_ms < 0))
