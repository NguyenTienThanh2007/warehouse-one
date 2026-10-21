{{ config(location=lake_path('gold', 'inventory_movements')) }}
-- Signed stock changes per location and SKU from inventory.* events (one row per side of a move).
with e as (select * from {{ ref('silver_inventory_events') }})

select event_id, simulation_id, "sequence", occurred_at, event_date,
       'receipt' as movement_type, sku, location_id, quantity as quantity_change, null as reason
from e where event_type = 'inventory.received'
union all
select event_id, simulation_id, "sequence", occurred_at, event_date,
       'transfer_out', sku, from_location_id, -quantity, null
from e where event_type = 'inventory.moved'
union all
select event_id, simulation_id, "sequence", occurred_at, event_date,
       'transfer_in', sku, to_location_id, quantity, null
from e where event_type = 'inventory.moved'
union all
select event_id, simulation_id, "sequence", occurred_at, event_date,
       'adjustment', sku, location_id, delta, reason
from e where event_type = 'inventory.adjusted'
