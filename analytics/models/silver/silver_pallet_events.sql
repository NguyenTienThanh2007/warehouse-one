{{ config(location=lake_path('silver', 'pallet_events')) }}
-- pallet.created / moved / removed with positions as kind + reference.
select
    event_id,
    simulation_id,
    "sequence",
    occurred_at,
    event_date,
    event_type,
    {{ p_text('pallet_id') }} as pallet_id,
    {{ p_text('sku') }} as sku,
    {{ p_text('cause') }} as cause,
    {{ p_text('reason') }} as reason,
    {{ p_text('task_id') }} as task_id,
    {{ position('at') }},
    {{ position('from') }},
    {{ position('to') }}
from {{ ref('silver_events') }}
where event_type in ('pallet.created', 'pallet.moved', 'pallet.removed')
