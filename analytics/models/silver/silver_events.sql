{{ config(location=lake_path('silver', 'events')) }}
-- One row per event_id (deduplicated). Copies of an event must be byte-identical (same envelope
-- hash); events with conflicting copies or an unsupported schema version are excluded here and
-- listed in silver_rejected_events instead. Full refresh on every run (DEC-029).
with bronze as (
    select * from {{ ref('stg_bronze_events') }}
),

copies as (
    select
        event_id,
        count(*) as delivery_copies,
        count(distinct envelope_sha256) as distinct_envelopes,
        min(ingested_at) as first_ingested_at,
        bool_or(source = 'kafka') as seen_on_kafka,
        bool_or(source = 'postgres-rebuild') as seen_in_rebuild
    from bronze
    group by event_id
),

ranked as (
    select
        *,
        row_number() over (
            partition by event_id
            order by
                case source when 'kafka' then 0 else 1 end,
                ingested_at,
                kafka_partition,
                kafka_offset
        ) as copy_rank
    from bronze
)

select
    r.event_id,
    r.event_type,
    r.schema_version,
    r.aggregate_type,
    r.aggregate_id,
    r.aggregate_version,
    r.simulation_id,
    r."sequence",
    r.occurred_at,
    r.event_date,
    r.simulation_time_ms,
    r.correlation_id,
    r.causation_id,
    r.payload_json,
    r.envelope_sha256,
    c.delivery_copies,
    c.first_ingested_at,
    c.seen_on_kafka,
    c.seen_in_rebuild
from ranked as r
inner join copies as c using (event_id)
where
    r.copy_rank = 1
    and c.distinct_envelopes = 1
    and {{ supported_version_predicate() }}
