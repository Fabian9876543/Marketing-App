CREATE TABLE `project_references` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`kind` text NOT NULL,
	`category` text DEFAULT 'sonstiges' NOT NULL,
	`title` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`file_path` text,
	`url` text,
	`mime` text,
	`size` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_references_project` ON `project_references` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`website` text,
	`color` text DEFAULT '#3150c8' NOT NULL,
	`folder` text NOT NULL,
	`brief` text DEFAULT '{}' NOT NULL,
	`default_hashtags` text DEFAULT '[]' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
-- Bestehende Daten aus der Zeit vor den Projekten in ein erstes Projekt übernehmen.
-- Den Ordner setzt die App beim Start (aus der alten Einstellung contentDir).
INSERT INTO `projects` (`id`, `slug`, `name`, `folder`) SELECT 1, 'fokuspilot', 'Fokuspilot', '' WHERE EXISTS (SELECT 1 FROM `accounts`) OR EXISTS (SELECT 1 FROM `contents`) OR EXISTS (SELECT 1 FROM `slots`);--> statement-breakpoint
-- SQLite kann keine Pflichtspalte mit Fremdschlüssel per ALTER TABLE hinzufügen; die App setzt project_id immer.
DROP INDEX `accounts_platform_external`;--> statement-breakpoint
ALTER TABLE `accounts` ADD `project_id` integer REFERENCES projects(id);--> statement-breakpoint
UPDATE `accounts` SET `project_id` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_project_platform_external` ON `accounts` (`project_id`,`platform`,`external_id`);--> statement-breakpoint
DROP INDEX `contents_slug_unique`;--> statement-breakpoint
ALTER TABLE `contents` ADD `project_id` integer REFERENCES projects(id);--> statement-breakpoint
UPDATE `contents` SET `project_id` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `contents_project_slug` ON `contents` (`project_id`,`slug`);--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `project_id` integer;--> statement-breakpoint
ALTER TABLE `slots` ADD `project_id` integer REFERENCES projects(id) ON DELETE CASCADE;--> statement-breakpoint
UPDATE `slots` SET `project_id` = 1;
