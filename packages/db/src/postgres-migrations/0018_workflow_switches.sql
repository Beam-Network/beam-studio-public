-- Ordered, multi-output Switch nodes extend the existing Decision engine.

ALTER TABLE workflow.decisions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'if';

ALTER TABLE workflow.decisions
  DROP CONSTRAINT IF EXISTS workflow_decisions_kind_check;
ALTER TABLE workflow.decisions
  ADD CONSTRAINT workflow_decisions_kind_check CHECK (kind IN ('if', 'switch'));

ALTER TABLE workflow.decision_edges
  DROP CONSTRAINT IF EXISTS workflow_decision_edges_branch_check;
ALTER TABLE workflow.decision_edges
  ADD CONSTRAINT workflow_decision_edges_branch_check CHECK (
    (
      from_decision_id IS NOT NULL
      AND branch IS NOT NULL
      AND (
        branch IN ('true', 'false', 'default')
        OR branch ~ '^case:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      )
    )
    OR (from_step_id IS NOT NULL AND branch IS NULL)
  );

ALTER TABLE execution.workflow_decision_evaluations
  ADD COLUMN IF NOT EXISTS decision_kind text NOT NULL DEFAULT 'if';

ALTER TABLE execution.workflow_decision_evaluations
  DROP CONSTRAINT IF EXISTS execution_workflow_decision_evaluations_kind_check;
ALTER TABLE execution.workflow_decision_evaluations
  ADD CONSTRAINT execution_workflow_decision_evaluations_kind_check
  CHECK (decision_kind IN ('if', 'switch'));

ALTER TABLE execution.workflow_decision_evaluations
  DROP CONSTRAINT IF EXISTS execution_workflow_decision_evaluations_branch_check;
ALTER TABLE execution.workflow_decision_evaluations
  ADD CONSTRAINT execution_workflow_decision_evaluations_branch_check CHECK (
    taken_branch IS NULL
    OR taken_branch IN ('true', 'false', 'default')
    OR taken_branch ~ '^case:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  );
