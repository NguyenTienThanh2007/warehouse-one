{# Lake locations. Silver and gold are single Parquet objects per model, rewritten on every run. #}
{% macro lake_path(layer, name) -%}
  s3://{{ env_var('WAREHOUSE_LAKE_BUCKET', 'warehouse-lake') }}/{{ layer }}/{{ name }}.parquet
{%- endmacro %}

{# Payload field as text / integer (NULL when absent). #}
{% macro p_text(field) -%} json_extract_string(payload_json, '$.{{ field }}') {%- endmacro %}
{% macro p_int(field) -%} try_cast(json_extract(payload_json, '$.{{ field }}') as bigint) {%- endmacro %}

{# SQL predicate: (event_type, schema_version) is one silver understands (var supported_versions). #}
{% macro supported_version_predicate() -%}
  (event_type, schema_version) in (
  {%- for event_type, versions in var('supported_versions').items() -%}
    {%- for v in versions %}('{{ event_type }}', {{ v }}){% if not loop.last %}, {% endif %}{% endfor -%}
    {%- if not loop.last %}, {% endif -%}
  {%- endfor -%}
  )
{%- endmacro %}

{# A pallet position object (slot / staging / equipment / truck) as kind + readable reference. #}
{% macro position(path) -%}
  json_extract_string(payload_json, '$.{{ path }}.kind') as {{ path }}_kind,
  case json_extract_string(payload_json, '$.{{ path }}.kind')
    when 'slot' then json_extract_string(payload_json, '$.{{ path }}.location_id')
      || '#' || json_extract_string(payload_json, '$.{{ path }}.slot')
    when 'staging' then json_extract_string(payload_json, '$.{{ path }}.dock_id')
      || '/lane-' || json_extract_string(payload_json, '$.{{ path }}.position')
    when 'equipment' then json_extract_string(payload_json, '$.{{ path }}.equipment_id')
    when 'truck' then json_extract_string(payload_json, '$.{{ path }}.truck_id')
      || '/' || json_extract_string(payload_json, '$.{{ path }}.position')
  end as {{ path }}_ref
{%- endmacro %}
