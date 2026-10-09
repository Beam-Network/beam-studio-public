-- Scope private Registry packages to the organization that installed them.
-- The Studio catalog was instance-wide, so one organization's private action
-- was listed and runnable by every organization on a shared Studio. NULL keeps
-- builtins and public/unlisted Registry packages instance-wide.
ALTER TABLE actions.packages ADD COLUMN IF NOT EXISTS organization_id text;
CREATE INDEX IF NOT EXISTS idx_actions_packages_organization
  ON actions.packages(organization_id)
  WHERE organization_id IS NOT NULL;
