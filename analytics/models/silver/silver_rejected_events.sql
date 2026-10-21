{{ config(location=lake_path('silver', 'rejected_events')) }}
-- Events silver does not accept, with the reason. Nothing is dropped silently.
with bronze as (
    select * from {{ ref('stg_bronze_events') }}
),

per_event as (
    select
        event_id,
        any_value(event_type) as event_type,
        any_value(schema_version) as schema_version,
        any_value(simulation_id) as simulation_id,
        any_value("sequence") as "sequence",
        count(*) as delivery_copies,
        count(distinct envelope_sha256) as distinct_envelopes
    from bronze
    group by event_id
)

select
    event_id,
    event_type,
    schema_version,
    simulation_id,
    "sequence",
    delivery_copies,
    case
        when distinct_envelopes > 1 then 'conflicting_copies'
        else 'unsupported_schema_version'
    end as reason
from per_event
where distinct_envelopes > 1 or not {{ supported_version_predicate() }}
