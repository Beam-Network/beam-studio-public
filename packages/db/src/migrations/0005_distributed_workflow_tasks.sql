CREATE TABLE IF NOT EXISTS `workflow_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`workflow_step_run_id` text,
	`workflow_step_id` text NOT NULL,
	`action_package_name` text NOT NULL,
	`task_kind` text NOT NULL,
	`shard_index` integer,
	`shard_count` integer,
	`status` text NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`output_json` text DEFAULT '{}' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`locked_by` text,
	`lock_expires_at` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_workflow_step_runs_unique_step` ON `workflow_step_runs` (`workflow_run_id`,`workflow_step_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_tasks_claim` ON `workflow_tasks` (`status`,`lock_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_tasks_run` ON `workflow_tasks` (`workflow_run_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_tasks_step` ON `workflow_tasks` (`workflow_step_run_id`,`task_kind`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_workflow_tasks_unique_shard` ON `workflow_tasks` (`workflow_step_run_id`,`task_kind`,COALESCE(`shard_index`, -1));
