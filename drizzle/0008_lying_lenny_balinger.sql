CREATE TABLE `app_database_resources` (
	`project_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'cloudflare-d1' NOT NULL,
	`isolation` text DEFAULT 'physical-database' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`external_database_id` text,
	`database_name` text NOT NULL,
	`location_hint` text,
	`schema_version` integer DEFAULT 0 NOT NULL,
	`last_migration_at` text,
	`last_backup_at` text,
	`retention_until` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_app_database_resources_external` ON `app_database_resources` (`external_database_id`);--> statement-breakpoint
CREATE INDEX `idx_app_database_resources_status_updated` ON `app_database_resources` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `backup_policies` (
	`project_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_hours` integer DEFAULT 24 NOT NULL,
	`retention_days` integer DEFAULT 30 NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `billing_accounts` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'stripe' NOT NULL,
	`customer_id` text,
	`subscription_id` text,
	`status` text DEFAULT 'configuration-required' NOT NULL,
	`plan` text DEFAULT 'demo' NOT NULL,
	`current_period_end` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_accounts_customer` ON `billing_accounts` (`customer_id`);--> statement-breakpoint
CREATE TABLE `billing_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`provider_event_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	`processed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_events_provider_event` ON `billing_events` (`provider_event_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_events_org_created` ON `billing_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `github_app_installations` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_login` text,
	`account_type` text,
	`permissions_json` text DEFAULT '{}' NOT NULL,
	`repository_selection` text,
	`status` text DEFAULT 'active' NOT NULL,
	`suspended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_github_app_installations_owner` ON `github_app_installations` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`project_id` text,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`recipient` text NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`provider_message_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`delivered_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_project_created` ON `notification_deliveries` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`state_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oauth_states_hash` ON `oauth_states` (`state_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_states_expiry` ON `oauth_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `provisioning_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`detail_json` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_provisioning_events_project_started` ON `provisioning_events` (`project_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `service_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`organization_id` text,
	`service` text NOT NULL,
	`operation` text NOT NULL,
	`level` text NOT NULL,
	`duration_ms` integer,
	`status_code` integer,
	`message` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_service_events_project_created` ON `service_events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_service_events_level_created` ON `service_events` (`level`,`created_at`);--> statement-breakpoint
ALTER TABLE `git_integrations` ADD `installation_id` text;