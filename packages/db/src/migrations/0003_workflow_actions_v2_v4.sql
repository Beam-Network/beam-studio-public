ALTER TABLE `workflow_steps` ADD COLUMN `execution_location_id` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_template_id` text NOT NULL,
	`from_step_id` text NOT NULL,
	`to_step_id` text NOT NULL,
	`condition_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_edges_template` ON `workflow_edges` (`workflow_template_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_edges_from` ON `workflow_edges` (`from_step_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_edges_to` ON `workflow_edges` (`to_step_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `execution_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT '__local__' NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`endpoint_url` text,
	`encrypted_headers` text,
	`enabled` integer DEFAULT true NOT NULL,
	`allow_insecure_http` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_execution_locations_org` ON `execution_locations` (`organization_id`,`enabled`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_execution_locations_kind` ON `execution_locations` (`kind`,`enabled`);
