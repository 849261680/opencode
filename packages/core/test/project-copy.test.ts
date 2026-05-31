import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Fiber, Layer, Stream } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Git } from "@opencode-ai/core/git"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectPathTable } from "@opencode-ai/core/project/path.sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const databaseLayer = Database.layerFromPath(":memory:")
const eventLayer = EventV2.layer.pipe(Layer.provide(databaseLayer))
const copyLayer = ProjectCopy.layer.pipe(
  Layer.provide(databaseLayer),
  Layer.provide(eventLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
const it = testEffect(Layer.mergeAll(copyLayer, databaseLayer, eventLayer))

function abs(input: string) {
  return AbsolutePath.make(input)
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

function setup() {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    yield* Effect.promise(() => initRepo(root.path))
    const primaryPath = abs(yield* Effect.promise(() => fs.realpath(root.path)))
    const projectID = Project.ID.make("copy-project")
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: root.path, sandboxes: [], time_created: 1, time_updated: 1 })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(ProjectPathTable)
      .values({ project_id: projectID, path: primaryPath, primary: true })
      .run()
      .pipe(Effect.orDie)
    return { root, primaryPath, projectID, db }
  })
}

function stored(projectID: Project.ID) {
  return Database.Service.use(({ db }) =>
    db
      .select({ path: ProjectPathTable.path, primary: ProjectPathTable.primary })
      .from(ProjectPathTable)
      .where(eq(ProjectPathTable.project_id, projectID))
      .all()
      .pipe(Effect.orDie, Effect.map((rows) => rows.toSorted((a, b) => a.path.localeCompare(b.path)))),
  )
}

describe("ProjectCopy", () => {
  it.effect("lists the initial git worktree strategy", () =>
    Effect.gen(function* () {
      const copy = yield* ProjectCopy.Service

      expect(yield* copy.strategies({ projectID: Project.ID.make("project") })).toEqual([
        { id: "git_worktree", name: "Git worktree" },
      ])
    }),
  )

  it.live("creates and removes a git worktree path", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const target = abs(`${input.root.path}-copy-created`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
      )

      const created = yield* copy.create({ projectID: input.projectID, strategy: "git_worktree", path: target })
      expect(yield* stored(input.projectID)).toEqual([
        { path: input.primaryPath, primary: true },
        { path: created.path, primary: false },
      ].toSorted((a, b) => a.path.localeCompare(b.path)))

      yield* copy.remove({ projectID: input.projectID, strategy: "git_worktree", path: created.path })

      expect(yield* stored(input.projectID)).toEqual([{ path: input.primaryPath, primary: true }])
      expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    }),
  )

  it.live("refresh discovers and prunes an externally managed git worktree", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const events = yield* EventV2.Service
      const target = abs(`${input.root.path}-copy-external`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${target} HEAD`.cwd(input.root.path).quiet())
      const fiber = yield* events.subscribe(ProjectCopy.Event.Updated).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* copy.refresh({ projectID: input.projectID, strategy: "git_worktree" })

      const discovered = abs(yield* Effect.promise(() => fs.realpath(target)))
      expect(yield* stored(input.projectID)).toEqual([
        { path: input.primaryPath, primary: true },
        { path: discovered, primary: false },
      ].toSorted((a, b) => a.path.localeCompare(b.path)))
      expect(Array.from(yield* Fiber.join(fiber))[0]?.data).toEqual({ projectID: input.projectID })

      yield* Effect.promise(() => $`git worktree remove --force ${target}`.cwd(input.root.path).quiet())
      yield* copy.refresh({ projectID: input.projectID, strategy: "git_worktree" })
      expect(yield* stored(input.projectID)).toEqual([{ path: input.primaryPath, primary: true }])
    }),
  )

  it.live("refuses to remove the primary project path", () =>
    Effect.gen(function* () {
      const input = yield* setup()
      const copy = yield* ProjectCopy.Service
      const result = yield* Effect.exit(
        copy.remove({ projectID: input.projectID, strategy: "git_worktree", path: input.primaryPath }),
      )

      expect(result._tag).toBe("Failure")
    }),
  )
})
