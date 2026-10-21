{{ config(location=lake_path('silver', 'inventory_events')) }}
-- inventory.received / moved / adjusted, typed (schema_version 1).
select
    event_id,
    simulation_id,
    "sequence",
    occurred_at,
    event_date,
    event_type,
    {{ p_text('sku') }} as sku,
    {{ p_text('location_id') }} as location_id,
    {{ p_text('from_location_id') }} as from_location_id,
    {{ p_text('to_location_id') }} as to_location_id,
    {{ p_int('quantity') }} as quantity,
    {{ p_int('delta') }} as delta,
    {{ p_text('reason') }} as reason,
    {{ p_int('location_quantity_after') }} as location_quantity_after
from {{ ref('silver_events') }}
where event_type in ('inventory.received', 'inventory.moved', 'inventory.adjusted')
