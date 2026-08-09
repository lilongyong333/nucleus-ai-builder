CREATE TABLE `generation_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`agent` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_generation_artifacts_run_kind` ON `generation_artifacts` (`run_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_generation_artifacts_project_run` ON `generation_artifacts` (`project_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `model_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`agent` text NOT NULL,
	`phase` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`first_token_ms` integer,
	`output_chars` integer DEFAULT 0 NOT NULL,
	`status_code` integer,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_model_attempts_run_created` ON `model_attempts` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_attempts_project_created` ON `model_attempts` (`project_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `generation_runs` ADD `current_stage` text DEFAULT 'requirements' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_runs` ADD `active_step` text;--> statement-breakpoint
ALTER TABLE `generation_runs` ADD `step_started_at` text;