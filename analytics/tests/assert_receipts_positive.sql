-- Receipts add stock; adjustments are never zero (the contract forbids both otherwise).
select *
from {{ ref('gold_inventory_movements') }}
where (movement_type = 'receipt' and quantity_change <= 0)
   or (movement_type = 'adjustment' and quantity_change = 0)
