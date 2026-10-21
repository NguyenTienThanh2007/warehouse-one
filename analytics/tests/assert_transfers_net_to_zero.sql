-- Each inventory transfer removes from one location exactly what it adds to another.
select event_id, sum(quantity_change) as net
from {{ ref('gold_inventory_movements') }}
where movement_type in ('transfer_out', 'transfer_in')
group by event_id
having sum(quantity_change) <> 0 or count(*) <> 2
