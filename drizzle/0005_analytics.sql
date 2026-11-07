CREATE TABLE `learnings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`text` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`source` text DEFAULT 'analysis' NOT NULL,
	`decided_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `learnings_project` ON `learnings` (`project_id`);--> statement-breakpoint
CREATE TABLE `media_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`url` text,
	`published_at` integer NOT NULL,
	`duration_sec` real,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`saves` integer,
	`reach` integer,
	`target_id` integer,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `post_targets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_items_account_external` ON `media_items` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `media_items_published` ON `media_items` (`published_at`);--> statement-breakpoint
CREATE TABLE `metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_id` integer NOT NULL,
	`at` integer NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	FOREIGN KEY (`media_id`) REFERENCES `media_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `metric_snapshots_media` ON `metric_snapshots` (`media_id`,`at`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `insights_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `insights_error` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `analysis_at` integer;--> statement-breakpoint
ALTER TABLE `studio_sessions` ADD `analysis` integer DEFAULT false NOT NULL;