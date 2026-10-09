-- Billing intent belongs to an invocation attempt, not to a mutable run column.
CREATE TABLE IF NOT EXISTS execution.workflow_billing_attempts (
  operation_key text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES execution.workflow_runs(id),
  attempt integer NOT NULL CHECK(attempt > 0),
  organization_id text NOT NULL,
  credential_id text,
  authority_key_id text,
  reservation_state text NOT NULL DEFAULT 'pending' CHECK(reservation_state IN ('pending','reserved','denied')),
  reserve_started_at timestamptz,
  outcome text CHECK(outcome IN ('completed','failed','cancelled')),
  settled_at timestamptz,
  error_code text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_run_id,attempt)
);
CREATE INDEX IF NOT EXISTS workflow_billing_unsettled ON execution.workflow_billing_attempts(created_at)
  WHERE outcome IS NOT NULL AND settled_at IS NULL;

-- Retain existing holds, including Job records imported into canonical history.
CREATE OR REPLACE FUNCTION execution.capture_workflow_billing_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_attempt integer;
BEGIN
  IF NEW.credit_operation_key IS NOT NULL THEN
    SELECT COALESCE(MAX(attempt),0)+1 INTO next_attempt FROM execution.workflow_billing_attempts WHERE workflow_run_id=NEW.id;
    INSERT INTO execution.workflow_billing_attempts(operation_key,workflow_run_id,attempt,organization_id,credential_id,reservation_state,outcome,settled_at)
    VALUES(NEW.credit_operation_key,NEW.id,next_attempt,NEW.organization_id,
      COALESCE(NEW.execution_context_json #>> '{billing,apiKeyId}',NEW.template_snapshot_json #>> '{workflowTemplate,apiKeyId}'),
      CASE WHEN NEW.historical THEN 'reserved' ELSE 'pending' END,
      CASE WHEN NEW.status IN ('completed','failed','cancelled') THEN NEW.status ELSE NULL END,NEW.credit_settled_at)
    ON CONFLICT(operation_key) DO NOTHING;
    IF EXISTS(SELECT 1 FROM execution.workflow_billing_attempts
      WHERE operation_key=NEW.credit_operation_key AND (workflow_run_id<>NEW.id OR organization_id<>NEW.organization_id)) THEN
      RAISE EXCEPTION 'Workflow billing identity belongs to another invocation';
    END IF;
    IF NEW.status IN ('completed','failed','cancelled') THEN
      UPDATE execution.workflow_billing_attempts SET outcome=COALESCE(outcome,NEW.status),updated_at=now()
      WHERE operation_key=NEW.credit_operation_key;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS capture_workflow_billing_attempt ON execution.workflow_runs;
CREATE TRIGGER capture_workflow_billing_attempt AFTER INSERT OR UPDATE OF status,credit_operation_key ON execution.workflow_runs
FOR EACH ROW EXECUTE FUNCTION execution.capture_workflow_billing_attempt();

INSERT INTO execution.workflow_billing_attempts(operation_key,workflow_run_id,attempt,organization_id,credential_id,reservation_state,outcome,settled_at)
SELECT credit_operation_key,id,1,organization_id,
  COALESCE(execution_context_json #>> '{billing,apiKeyId}',template_snapshot_json #>> '{workflowTemplate,apiKeyId}'),
  'reserved',CASE WHEN status IN ('completed','failed','cancelled') THEN status ELSE NULL END,credit_settled_at
FROM execution.workflow_runs WHERE credit_operation_key IS NOT NULL
ON CONFLICT(operation_key) DO NOTHING;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM execution.workflow_runs r
    LEFT JOIN execution.workflow_billing_attempts b ON b.operation_key=r.credit_operation_key
    WHERE r.credit_operation_key IS NOT NULL AND
      (b.operation_key IS NULL OR b.workflow_run_id<>r.id OR b.organization_id<>r.organization_id)) THEN
    RAISE EXCEPTION 'Workflow billing history failed ownership verification';
  END IF;
END $$;
