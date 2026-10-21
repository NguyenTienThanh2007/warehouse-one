-- A task is assigned no earlier than it is created and completed no earlier than assigned.
select *
from {{ ref('gold_task_lifecycle') }}
where assigned_ms < created_ms
   or completed_ms < assigned_ms
   or (status = 'completed' and assigned_ms is null)
