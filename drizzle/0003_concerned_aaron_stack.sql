ALTER TABLE `projects` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `published_version_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `generation_id` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `generation_started_at` text;--> statement-breakpoint
UPDATE `projects` SET `published_version_id` = `current_version_id` WHERE `slug` IS NOT NULL AND `current_version_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_projects_owner_updated` ON `projects` (`owner_id`,`updated_at`);
