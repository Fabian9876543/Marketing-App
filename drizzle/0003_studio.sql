CREATE TABLE `studio_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`run_id` integer,
	`kind` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`tool_name` text,
	`is_error` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `studio_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `studio_messages_session` ON `studio_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `studio_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`prompt` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`pid` integer,
	`error` text,
	`cost_usd` real,
	`duration_ms` integer,
	`new_shorts` text DEFAULT '[]' NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `studio_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `studio_runs_state` ON `studio_runs` (`state`);--> statement-breakpoint
CREATE INDEX `studio_runs_session` ON `studio_runs` (`session_id`);--> statement-breakpoint
CREATE TABLE `studio_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`title` text NOT NULL,
	`claude_session_id` text NOT NULL,
	`started` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `studio_sessions_claude_session_id_unique` ON `studio_sessions` (`claude_session_id`);--> statement-breakpoint
CREATE INDEX `studio_sessions_project` ON `studio_sessions` (`project_id`);