CREATE TABLE `project_path` (
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`primary` integer DEFAULT false NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `project_path_pk` PRIMARY KEY(`project_id`, `path`),
	CONSTRAINT `fk_project_path_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_path_project_primary_idx` ON `project_path` (`project_id`) WHERE "project_path"."primary" = 1;