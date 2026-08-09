CREATE TABLE `app_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`label` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`record_count` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_app_backups_project_created` ON `app_backups` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `app_manifests` (
	`project_id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`manifest_json` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_app_manifests_version` ON `app_manifests` (`version_id`);--> statement-breakpoint
CREATE TABLE `app_records` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`collection` text NOT NULL,
	`owner_subject` text NOT NULL,
	`data_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_app_records_project_collection_updated` ON `app_records` (`project_id`,`collection`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_app_records_project_owner_collection` ON `app_records` (`project_id`,`owner_subject`,`collection`);--> statement-breakpoint
CREATE TABLE `app_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`access_token_hash` text NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`role` text NOT NULL,
	`display_name` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_app_sessions_access_hash` ON `app_sessions` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_app_sessions_refresh_hash` ON `app_sessions` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_app_sessions_project_subject` ON `app_sessions` (`project_id`,`subject_id`);--> statement-breakpoint
CREATE INDEX `idx_app_sessions_expires` ON `app_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `git_integrations` (
	`project_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`repository_owner` text NOT NULL,
	`repository_name` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`status` text NOT NULL,
	`last_sync_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`email` text,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_organization_members_subject` ON `organization_members` (`organization_id`,`subject_id`);--> statement-breakpoint
CREATE INDEX `idx_organization_members_email` ON `organization_members` (`email`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'demo' NOT NULL,
	`monthly_token_limit` integer DEFAULT 2000000 NOT NULL,
	`approval_required` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_organizations_owner` ON `organizations` (`owner_id`);--> statement-breakpoint
CREATE TABLE `project_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version_id` text NOT NULL,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`reviewed_by` text,
	`comment` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_project_approvals_project_created` ON `project_approvals` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `race_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`stage` text NOT NULL,
	`model` text NOT NULL,
	`artifact` text NOT NULL,
	`score` integer NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	`output_chars` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_race_candidates_run_stage` ON `race_candidates` (`run_id`,`stage`);--> statement-breakpoint
CREATE TABLE `runner_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`request_json` text NOT NULL,
	`result_json` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_runner_jobs_project_created` ON `runner_jobs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `runtime_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version_id` text,
	`session_id` text,
	`source` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`evidence_json` text NOT NULL,
	`processed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_runtime_evidence_project_created` ON `runtime_evidence` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`project_id` text NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit` text NOT NULL,
	`model` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_events_project_created` ON `usage_events` (`project_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `generation_runs` ADD `mode` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `organization_id` text;--> statement-breakpoint
ALTER TABLE `versions` ADD `manifest_json` text;