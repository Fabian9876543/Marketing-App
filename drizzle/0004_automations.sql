CREATE TABLE `automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`recipe` text NOT NULL,
	`time` text DEFAULT '06:00' NOT NULL,
	`weekdays` text DEFAULT '[1,2,3,4,5]' NOT NULL,
	`shorts_per_run` integer DEFAULT 1 NOT NULL,
	`auto_schedule` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source_session_id` integer,
	`last_run_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automations_project` ON `automations` (`project_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_fill` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_fill_days` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `studio_sessions` ADD `automation_id` integer REFERENCES automations(id) ON DELETE SET NULL;