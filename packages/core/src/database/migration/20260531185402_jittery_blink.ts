import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260531185402_jittery_blink",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`project_path\` (
          \`project_id\` text NOT NULL,
          \`path\` text NOT NULL,
          \`primary\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`project_path_pk\` PRIMARY KEY(\`project_id\`, \`path\`),
          CONSTRAINT \`fk_project_path_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`project_path_project_primary_idx\` ON \`project_path\` (\`project_id\`) WHERE "project_path"."primary" = 1;`)
    })
  },
} satisfies DatabaseMigration.Migration
