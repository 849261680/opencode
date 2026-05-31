import { sql } from "drizzle-orm"
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectTable } from "./sql"
import { ProjectV2 } from "../project"

export const ProjectPathTable = sqliteTable(
  "project_path",
  {
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    path: text().notNull(),
    primary: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.path] }),
    uniqueIndex("project_path_project_primary_idx")
      .on(table.project_id)
      .where(sql`${table.primary} = 1`),
  ],
)
