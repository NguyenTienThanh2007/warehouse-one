{{ config(location=lake_path('gold', 'pallet_flows')) }}
-- Pallet movements between position kinds (rack slot, staging lane, forks, trailer).
select
    event_id,
    simulation_id,
    "sequence",
    occurred_at,
    event_date,
    pallet_id,
    sku,
    case event_type
        when 'pallet.created' then 'created'
        when 'pallet.moved' then 'moved'
        else 'removed'
    end as flow,
    coalesce(cause, reason) as cause_or_reason,
    task_id,
    case when event_type = 'pallet.created' then null else from_kind end as from_kind,
    case when event_type = 'pallet.created' then null else from_ref end as from_ref,
    case event_type when 'pallet.created' then at_kind when 'pallet.moved' then to_kind end as to_kind,
    case event_type when 'pallet.created' then at_ref when 'pallet.moved' then to_ref end as to_ref
from {{ ref('silver_pallet_events') }}
