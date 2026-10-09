ALTER TABLE `runs` ADD COLUMN `workflow_run_id` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `action_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`source` text NOT NULL,
	`manifest_json` text NOT NULL,
	`checksum` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_action_packages_name_version` ON `action_packages` (`name`,`version`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_action_packages_source` ON `action_packages` (`source`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT '__local__' NOT NULL,
	`legacy_transfer_template_id` text,
	`name` text NOT NULL,
	`description` text,
	`config_json` text DEFAULT '{}' NOT NULL,
	`retry_policy_json` text DEFAULT '{}' NOT NULL,
	`timeout_seconds` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_templates_org` ON `workflow_templates` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_templates_legacy_transfer` ON `workflow_templates` (`legacy_transfer_template_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_template_id` text NOT NULL,
	`action_package_name` text NOT NULL,
	`action_version_range` text DEFAULT '*' NOT NULL,
	`position` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`input_bindings_json` text DEFAULT '{}' NOT NULL,
	`placement` text DEFAULT 'local-workers' NOT NULL,
	`timeout_seconds` integer,
	`required` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CHECK (`position` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_workflow_steps_unique_position` ON `workflow_steps` (`workflow_template_id`,`position`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_steps_template_position` ON `workflow_steps` (`workflow_template_id`,`position`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_steps_action` ON `workflow_steps` (`action_package_name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_template_id` text NOT NULL,
	`legacy_run_id` text,
	`status` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`template_snapshot_json` text NOT NULL,
	`resolved_steps_json` text NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`output_json` text DEFAULT '{}' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`queued_at` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_runs_claim` ON `workflow_runs` (`status`,`queued_at`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_runs_template_history` ON `workflow_runs` (`workflow_template_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_runs_legacy_run` ON `workflow_runs` (`legacy_run_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_step_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`workflow_step_id` text NOT NULL,
	`action_package_name` text NOT NULL,
	`resolved_version` text NOT NULL,
	`checksum` text NOT NULL,
	`source_registry` text NOT NULL,
	`resolved_placement` text NOT NULL,
	`execution_location_id` text,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`output_json` text DEFAULT '{}' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`state_json` text DEFAULT '{}' NOT NULL,
	`external_ref` text,
	`error` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_step_runs_workflow` ON `workflow_step_runs` (`workflow_run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_step_runs_step` ON `workflow_step_runs` (`workflow_step_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_step_runs_status` ON `workflow_step_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`workflow_step_run_id` text,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`uri` text NOT NULL,
	`media_type` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_artifacts_run` ON `workflow_artifacts` (`workflow_run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_artifacts_step_run` ON `workflow_artifacts` (`workflow_step_run_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_action_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_template_id` text NOT NULL,
	`action_package_name` text NOT NULL,
	`version_range` text NOT NULL,
	`resolved_version` text NOT NULL,
	`checksum` text NOT NULL,
	`source_registry` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_action_locks_template` ON `workflow_action_locks` (`workflow_template_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_action_locks_package` ON `workflow_action_locks` (`action_package_name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_workflow_run` ON `runs` (`workflow_run_id`);
