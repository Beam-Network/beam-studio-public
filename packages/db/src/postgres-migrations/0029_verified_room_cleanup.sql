-- Correct only provisional warnings contradicted by independent resource/process cleanup.
WITH verified AS MATERIALIZED (
  SELECT a.id AS assignment_id, t.id AS task_id, s.id AS step_id
  FROM execution.executor_assignments a
  JOIN execution.workflow_tasks t ON t.id=a.task_id AND t.attempt_count=a.attempt
  JOIN execution.workflow_step_runs s ON s.id=t.workflow_step_run_id
  JOIN execution.workflow_runs r ON r.id=t.workflow_run_id
  WHERE a.state='cancelled' AND t.status='cancelled' AND s.status='cancelled' AND r.status='cancelled'
    AND a.executor_stopped_at IS NOT NULL AND a.cleanup_confirmed_at IS NOT NULL
    AND s.resource_execution_json->>'kind'='room-publication'
    AND s.resource_execution_json->>'state'='cancelled'
), assignments AS (
  UPDATE execution.executor_assignments a
  SET error_json='{"code":"executor_cancelled","message":"Execution cancelled."}'::jsonb, updated_at=now()
  FROM verified v WHERE a.id=v.assignment_id
    AND a.error_json->>'message'='Room publication cleanup remains unconfirmed.'
  RETURNING a.id
), tasks AS (
  UPDATE execution.workflow_tasks t SET error='Execution cancelled.', updated_at=now()
  FROM verified v WHERE t.id=v.task_id AND t.error='Room publication cleanup remains unconfirmed.'
  RETURNING t.id
), attempts AS (
  UPDATE execution.workflow_task_attempts t SET error='Execution cancelled.'
  FROM verified v JOIN execution.executor_assignments a ON a.id=v.assignment_id
  WHERE t.workflow_task_id=v.task_id AND t.attempt_number=a.attempt
    AND t.error='Room publication cleanup remains unconfirmed.'
  RETURNING t.id
)
UPDATE execution.workflow_step_runs s SET error='Execution cancelled.', updated_at=now()
FROM verified v WHERE s.id=v.step_id AND s.error='Room publication cleanup remains unconfirmed.';
