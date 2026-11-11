ALTER TABLE `projects` ADD `research` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `research_at` integer;--> statement-breakpoint
ALTER TABLE `studio_sessions` ADD `research` integer DEFAULT false NOT NULL;