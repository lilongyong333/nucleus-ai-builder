ALTER TABLE `projects` ADD `intake_json` text;--> statement-breakpoint
UPDATE `organizations` SET `monthly_token_limit`=10000000 WHERE `plan`='demo' AND `monthly_token_limit`<10000000;
