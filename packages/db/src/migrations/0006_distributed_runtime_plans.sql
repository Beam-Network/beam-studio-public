CREATE TABLE IF NOT EXISTS `worker_runtime_state` (
	`worker_id` text PRIMARY KEY NOT NULL,
	`network_identity` text NOT NULL,
	`status` text NOT NULL,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`reachability` text DEFAULT 'local' NOT NULL,
	`accessible_endpoints_json` text DEFAULT '[]' NOT NULL,
	`cpu_load` real DEFAULT 0 NOT NULL,
	`memory_used_bytes` integer DEFAULT 0 NOT NULL,
	`memory_total_bytes` integer DEFAULT 0 NOT NULL,
	`bandwidth_mbps` real DEFAULT 0 NOT NULL,
	`active_task_count` integer DEFAULT 0 NOT NULL,
	`load_score` real DEFAULT 0 NOT NULL,
	`heartbeat_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `execution_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`workflow_step_run_id` text NOT NULL,
	`workflow_step_id` text NOT NULL,
	`status` text NOT NULL,
	`mode` text NOT NULL,
	`shard_count` integer DEFAULT 1 NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `execution_plan_shards` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_plan_id` text NOT NULL,
	`workflow_task_id` text,
	`shard_index` integer,
	`shard_kind` text NOT NULL,
	`assigned_worker_id` text,
	`nats_subject` text NOT NULL,
	`status` text NOT NULL,
	`input_weight` integer DEFAULT 0 NOT NULL,
	`source_locality` text,
	`destination_locality` text,
	`output_checksum` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_task_dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_task_id` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`workflow_step_run_id` text,
	`reason` text NOT NULL,
	`error` text NOT NULL,
	`attempts` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workflow_tasks` ADD COLUMN `retry_policy_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `workflow_tasks` ADD COLUMN `target_worker_id` text;
--> statement-breakpoint
ALTER TABLE `workflow_tasks` ADD COLUMN `nats_subject` text;
--> statement-breakpoint
ALTER TABLE `workflow_tasks` ADD COLUMN `idempotency_key` text;
--> statement-breakpoint
ALTER TABLE `workflow_tasks` ADD COLUMN `input_checksum` text;
--> statement-breakpoint
ALTER TABLE `workflow_tasks` ADD COLUMN `output_checksum` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_worker_runtime_state_status` ON `worker_runtime_state` (`status`,`heartbeat_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_worker_runtime_state_load` ON `worker_runtime_state` (`status`,`load_score`,`active_task_count`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_execution_plans_step_run` ON `execution_plans` (`workflow_step_run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_execution_plans_run` ON `execution_plans` (`workflow_run_id`,`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_execution_plan_shards_plan` ON `execution_plan_shards` (`execution_plan_id`,`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_execution_plan_shards_task` ON `execution_plan_shards` (`workflow_task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_tasks_target` ON `workflow_tasks` (`target_worker_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_workflow_tasks_idempotency` ON `workflow_tasks` (`idempotency_key`) WHERE `idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workflow_task_dead_letters_workflow_task_id_unique` ON `workflow_task_dead_letters` (`workflow_task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_task_dead_letters_created` ON `workflow_task_dead_letters` (`created_at`);
