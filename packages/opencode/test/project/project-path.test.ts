import { describe, expect } from "bun:test"
import { $ } from "bun"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Hash } from "@opencode-ai/core/util/hash"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectPathTable } from "@opencode-ai/core/project/path.sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Project } from "@/project/project"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Project.defaultLayer, Database.defaultLayer, CrossSpawnSpawner.defaultLayer))

function paths(projectID: ProjectV2.ID) {
  return Database.Service.use(({ db }) =>
    db
      .select()
      .from(ProjectPathTable)
      .where(eq(ProjectPathTable.project_id, projectID))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) =>
          rows.map((row) => ({ path: row.path, primary: row.primary })).toSorted((a, b) => a.path.localeCompare(b.path)),
        ),
      ),
  )
}

describe("Project path persistence", () => {
  it.live("stores the first opened checkout as the primary path", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const project = yield* Project.Service

      const result = yield* project.fromDirectory(tmp)

      expect(yield* paths(result.project.id)).toEqual([{ path: tmp, primary: true }])
    }),
  )

  it.live("stores an opened linked worktree as a secondary path", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const project = yield* Project.Service
      const main = yield* project.fromDirectory(tmp)
      const worktree = path.join(tmp, "..", path.basename(tmp) + "-project-path-worktree")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove ${worktree}`.cwd(tmp).quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add ${worktree} -b project-path-${Date.now()}`.cwd(tmp).quiet())

      yield* project.fromDirectory(worktree)

      expect(yield* paths(main.project.id)).toEqual(
        [
          { path: tmp, primary: true },
          { path: worktree, primary: false },
        ].toSorted((a, b) => a.path.localeCompare(b.path)),
      )
    }),
  )

  it.live("stores a separately opened clone as a secondary path", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const bare = tmp + "-project-path-bare"
      const clone = tmp + "-project-path-clone"
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bare} ${clone}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git clone --bare ${tmp} ${bare}`.quiet())
      yield* Effect.promise(() => $`git clone ${bare} ${clone}`.quiet())
      const project = yield* Project.Service
      const main = yield* project.fromDirectory(tmp)

      yield* project.fromDirectory(clone)

      expect(yield* paths(main.project.id)).toEqual(
        [
          { path: tmp, primary: true },
          { path: clone, primary: false },
        ].toSorted((a, b) => a.path.localeCompare(b.path)),
      )
    }),
  )

  it.live("keeps an existing remote project primary when migrating an inferred project id", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const project = yield* Project.Service
      yield* project.fromDirectory(tmp)
      const remoteID = ProjectV2.ID.make(Hash.fast("git-remote:github.com/project-path-test/collision"))
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: remoteID,
          worktree: "/tmp/existing",
          vcs: "git",
          time_created: Date.now(),
          time_updated: Date.now(),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ProjectPathTable)
        .values({ project_id: remoteID, path: "/tmp/existing", primary: true })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() => $`git remote add origin git@github.com:project-path-test/collision.git`.cwd(tmp).quiet())

      yield* project.fromDirectory(tmp)

      expect(yield* paths(remoteID)).toEqual(
        [
          { path: "/tmp/existing", primary: true },
          { path: tmp, primary: false },
        ].toSorted((a, b) => a.path.localeCompare(b.path)),
      )
    }),
  )
})
