CREATE TABLE `agent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`agent` text NOT NULL,
	`phase` text NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`duration_ms` integer,
	`model` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_events_run_sequence` ON `agent_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_agent_events_project_created` ON `agent_events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `generation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`duration_ms` integer,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`repair_count` integer DEFAULT 0 NOT NULL,
	`version_id` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_generation_runs_project_started` ON `generation_runs` (`project_id`,`started_at`);
--> statement-breakpoint
PRAGMA optimize;
