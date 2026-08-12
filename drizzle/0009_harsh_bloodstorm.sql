CREATE TABLE `billing_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider_invoice_id` text NOT NULL,
	`status` text NOT NULL,
	`currency` text NOT NULL,
	`amount_due` integer DEFAULT 0 NOT NULL,
	`amount_paid` integer DEFAULT 0 NOT NULL,
	`hosted_invoice_url` text,
	`invoice_pdf` text,
	`period_start` text,
	`period_end` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_billing_invoices_provider` ON `billing_invoices` (`provider_invoice_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_invoices_org_created` ON `billing_invoices` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `operational_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`project_id` text,
	`organization_id` text,
	`service` text NOT NULL,
	`operation` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_operational_alerts_retry` ON `operational_alerts` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_operational_alerts_fingerprint_created` ON `operational_alerts` (`fingerprint`,`created_at`);--> statement-breakpoint
ALTER TABLE `app_backups` ADD `archive_key` text;--> statement-breakpoint
ALTER TABLE `app_backups` ADD `archive_status` text DEFAULT 'not-configured' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_backups` ADD `archive_bytes` integer;--> statement-breakpoint
ALTER TABLE `app_backups` ADD `archive_error` text;--> statement-breakpoint
ALTER TABLE `app_backups` ADD `expires_at` text;--> statement-breakpoint
ALTER TABLE `app_database_resources` ADD `desired_schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_database_resources` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_database_resources` ADD `next_retry_at` text;--> statement-breakpoint
ALTER TABLE `app_database_resources` ADD `lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `payload_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `next_attempt_at` text;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `last_attempt_at` text;--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_retry` ON `notification_deliveries` (`status`,`next_attempt_at`);