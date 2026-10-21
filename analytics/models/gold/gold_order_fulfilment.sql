{{ config(location=lake_path('gold', 'order_fulfilment')) }}
-- One row per order: open → in progress → shipped / cancelled, in simulated time.
with o as (select * from {{ ref('silver_order_events') }})

select
    simulation_id,
    order_id,
    any_value(truck_id) as truck_id,
    any_value(total_pallets) filter (where to_status = 'open') as ordered_pallets,
    min(simulation_time_ms) filter (where to_status = 'open') as opened_ms,
    min(simulation_time_ms) filter (where to_status = 'in_progress') as started_ms,
    min(simulation_time_ms) filter (where to_status = 'shipped') as shipped_ms,
    min(simulation_time_ms) filter (where to_status = 'cancelled') as cancelled_ms,
    case
        when count(*) filter (where to_status = 'shipped') > 0 then 'shipped'
        when count(*) filter (where to_status = 'cancelled') > 0 then 'cancelled'
        when count(*) filter (where to_status = 'in_progress') > 0 then 'in_progress'
        else 'open'
    end as status,
    min(simulation_time_ms) filter (where to_status = 'shipped')
        - min(simulation_time_ms) filter (where to_status = 'open') as lead_time_ms
from o
group by simulation_id, order_id
