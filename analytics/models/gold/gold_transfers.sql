{{ config(location=lake_path('gold', 'transfers')) }}
-- One row per inter-site transfer (Phase 5): planned → assigned → loading → in transit →
-- unloading → delivered / cancelled, in simulated time. Pallets from the transfer's lines.
with t as (
    select
        simulation_id,
        simulation_time_ms,
        {{ p_text('transfer_id') }} as transfer_id,
        {{ p_text('lane_id') }} as lane_id,
        {{ p_text('from_site_id') }} as from_site_id,
        {{ p_text('to_site_id') }} as to_site_id,
        {{ p_text('to') }} as to_status,
        {{ p_text('vehicle_id') }} as vehicle_id,
        (
            select coalesce(sum(cast(l ->> 'quantity' as bigint)), 0)
            from (select unnest(json_extract(payload_json, '$.lines[*]')) as l)
        ) as pallets
    from {{ ref('silver_events') }}
    where event_type = 'transfer.status_changed'
)

select
    simulation_id,
    transfer_id,
    any_value(lane_id) as lane_id,
    any_value(from_site_id) as from_site_id,
    any_value(to_site_id) as to_site_id,
    any_value(pallets) filter (where to_status = 'planned') as pallets,
    any_value(vehicle_id) filter (where vehicle_id is not null) as vehicle_id,
    min(simulation_time_ms) filter (where to_status = 'planned') as planned_ms,
    min(simulation_time_ms) filter (where to_status = 'in_transit') as dispatched_ms,
    min(simulation_time_ms) filter (where to_status = 'delivered') as delivered_ms,
    min(simulation_time_ms) filter (where to_status = 'cancelled') as cancelled_ms,
    case
        when count(*) filter (where to_status = 'delivered') > 0 then 'delivered'
        when count(*) filter (where to_status = 'cancelled') > 0 then 'cancelled'
        when count(*) filter (where to_status = 'in_transit' or to_status = 'unloading') > 0
            then 'in_transit'
        else 'open'
    end as status,
    min(simulation_time_ms) filter (where to_status = 'delivered')
        - min(simulation_time_ms) filter (where to_status = 'planned') as lead_time_ms
from t
group by simulation_id, transfer_id
