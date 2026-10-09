-- Decision nodes: a first-class graph object between steps that joins several inputs,
-- evaluates a declarative predicate, and routes to a true or false branch.
-- Modelled on workflow.triggers / workflow.trigger_edges.

-- Prerequisite for the composite foreign keys on workflow.decision_edges. Trivially
-- satisfied because id is already the primary key.
-- This constraint cannot use the DROP CONSTRAINT IF EXISTS + ADD idiom used for CHECK
-- constraints elsewhere: decision_edges depends on it, so a DROP fails with "cannot drop
-- constraint ... because other objects depend on it" on the second apply, and CASCADE
-- would drop those foreign keys instead. Guard on the catalog so the chain stays idempotent.
DO $$
BEGIN
  IF to_regclass('workflow.steps') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_steps_template_id_unique'
      AND conrelid = 'workflow.steps'::regclass
  ) THEN
    ALTER TABLE workflow.steps
      ADD CONSTRAINT workflow_steps_template_id_unique UNIQUE (workflow_template_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workflow.decisions (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  join_mode text NOT NULL DEFAULT 'all',
  handle_failure boolean NOT NULL DEFAULT false,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  canvas_x real,
  canvas_y real,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_decisions_join_mode_check CHECK (join_mode IN ('all', 'any_settled')),
  CONSTRAINT workflow_decisions_template_id_unique UNIQUE (workflow_template_id, id)
);

CREATE TABLE IF NOT EXISTS workflow.decision_edges (
  id text PRIMARY KEY,
  workflow_template_id text NOT NULL REFERENCES workflow.templates(id) ON DELETE CASCADE,
  from_step_id text,
  from_decision_id text,
  to_step_id text,
  to_decision_id text,
  branch text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- exactly one endpoint on each side
  CONSTRAINT workflow_decision_edges_from_check
    CHECK ((from_step_id IS NOT NULL) <> (from_decision_id IS NOT NULL)),
  CONSTRAINT workflow_decision_edges_to_check
    CHECK ((to_step_id IS NOT NULL) <> (to_decision_id IS NOT NULL)),
  -- branch is meaningful only on edges leaving a decision.
  -- branch IS NOT NULL is required explicitly: without it a NULL branch makes
  -- "branch IN ('true','false')" evaluate to NULL, and a CHECK passes on NULL.
  CONSTRAINT workflow_decision_edges_branch_check CHECK (
    (from_decision_id IS NOT NULL AND branch IS NOT NULL AND branch IN ('true', 'false'))
    OR (from_step_id IS NOT NULL AND branch IS NULL)
  ),
  -- every endpoint must belong to the same template. Per-column foreign keys do not
  -- guarantee this. MATCH SIMPLE skips each pair whose nullable column is NULL, which is
  -- exactly the behaviour wanted here.
  CONSTRAINT workflow_decision_edges_from_step_fk
    FOREIGN KEY (workflow_template_id, from_step_id)
    REFERENCES workflow.steps (workflow_template_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_decision_edges_from_decision_fk
    FOREIGN KEY (workflow_template_id, from_decision_id)
    REFERENCES workflow.decisions (workflow_template_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_decision_edges_to_step_fk
    FOREIGN KEY (workflow_template_id, to_step_id)
    REFERENCES workflow.steps (workflow_template_id, id) ON DELETE CASCADE,
  CONSTRAINT workflow_decision_edges_to_decision_fk
    FOREIGN KEY (workflow_template_id, to_decision_id)
    REFERENCES workflow.decisions (workflow_template_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_decisions_template
  ON workflow.decisions (workflow_template_id);
CREATE INDEX IF NOT EXISTS idx_workflow_decision_edges_template
  ON workflow.decision_edges (workflow_template_id);

-- Durable audit trail. Load-bearing, not merely diagnostic: run finalization reads
-- handled_failures to decide whether a failed step still fails the run.
CREATE TABLE IF NOT EXISTS execution.workflow_decision_evaluations (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id) ON DELETE CASCADE,
  decision_id text NOT NULL,
  scope_key text NOT NULL DEFAULT 'root',
  join_mode text NOT NULL,
  evaluated boolean NOT NULL,
  result boolean,
  taken_branch text,
  handled_failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_workflow_decision_evaluations_branch_check CHECK (
    taken_branch IS NULL OR taken_branch IN ('true', 'false')
  ),
  CONSTRAINT execution_workflow_decision_evaluations_unique
    UNIQUE (workflow_run_id, scope_key, decision_id)
);

CREATE INDEX IF NOT EXISTS idx_execution_workflow_decision_evaluations_run
  ON execution.workflow_decision_evaluations (workflow_run_id, created_at);
