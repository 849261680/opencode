export * as ProjectCopy from "./copy"

import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { AbsolutePath } from "../schema"
import { AppFileSystem } from "../filesystem"
import { Git } from "../git"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Project } from "../project"
import { ProjectPathTable } from "./path.sql"
import { makeStrategies } from "./copy-strategies"

export const StrategyID = Schema.Literal("git_worktree")
export type StrategyID = typeof StrategyID.Type

export const StrategiesInput = Schema.Struct({
  projectID: Project.ID,
}).annotate({ identifier: "ProjectCopy.StrategiesInput" })
export type StrategiesInput = typeof StrategiesInput.Type

export const CreateInput = Schema.Struct({
  projectID: Project.ID,
  strategy: StrategyID,
  path: AbsolutePath,
}).annotate({ identifier: "ProjectCopy.CreateInput" })
export type CreateInput = typeof CreateInput.Type

export const RemoveInput = CreateInput.annotate({ identifier: "ProjectCopy.RemoveInput" })
export type RemoveInput = typeof RemoveInput.Type

export const RefreshInput = Schema.Struct({
  projectID: Project.ID,
  strategy: Schema.optional(StrategyID),
}).annotate({ identifier: "ProjectCopy.RefreshInput" })
export type RefreshInput = typeof RefreshInput.Type

export const StrategyInfo = Schema.Struct({
  id: StrategyID,
  name: Schema.String,
}).annotate({ identifier: "ProjectCopy.StrategyInfo" })
export type StrategyInfo = typeof StrategyInfo.Type

export const Copy = Schema.Struct({
  path: AbsolutePath,
}).annotate({ identifier: "ProjectCopy.Copy" })
export type Copy = typeof Copy.Type

export class PrimaryPathNotFoundError extends Schema.TaggedErrorClass<PrimaryPathNotFoundError>()(
  "ProjectCopy.PrimaryPathNotFoundError",
  { projectID: Project.ID },
) {}

export class CannotRemovePrimaryPathError extends Schema.TaggedErrorClass<CannotRemovePrimaryPathError>()(
  "ProjectCopy.CannotRemovePrimaryPathError",
  { projectID: Project.ID, path: AbsolutePath },
) {}

export class DestinationExistsError extends Schema.TaggedErrorClass<DestinationExistsError>()(
  "ProjectCopy.DestinationExistsError",
  { path: AbsolutePath },
) {}

export class PathUnavailableError extends Schema.TaggedErrorClass<PathUnavailableError>()(
  "ProjectCopy.PathUnavailableError",
  { path: AbsolutePath },
) {}

export type Error =
  | PrimaryPathNotFoundError
  | CannotRemovePrimaryPathError
  | DestinationExistsError
  | PathUnavailableError
  | Git.WorktreeError

export interface Strategy {
  readonly id: StrategyID
  readonly name: string
  readonly create: (input: {
    projectID: Project.ID
    primaryPath: AbsolutePath
    path: AbsolutePath
  }) => Effect.Effect<Copy, Git.WorktreeError | PathUnavailableError>
  readonly remove: (input: {
    projectID: Project.ID
    primaryPath: AbsolutePath
    path: AbsolutePath
  }) => Effect.Effect<void, Git.WorktreeError | PathUnavailableError>
  readonly list: (input: {
    projectID: Project.ID
    primaryPath: AbsolutePath
  }) => Effect.Effect<Copy[], Git.WorktreeError | PathUnavailableError>
}

export const Event = {
  Updated: EventV2.define({
    type: "project.paths.updated",
    schema: { projectID: Project.ID },
  }),
}

export interface Interface {
  readonly strategies: (input: StrategiesInput) => Effect.Effect<StrategyInfo[]>
  readonly create: (input: CreateInput) => Effect.Effect<Copy, Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<void, Error>
  readonly refresh: (input: RefreshInput) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectCopy") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const git = yield* Git.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db

    const canonical = Effect.fnUntraced(function* (input: AbsolutePath) {
      const real = yield* fs.realPath(input).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!real || !(yield* fs.isDir(real))) return yield* new PathUnavailableError({ path: input })
      return AbsolutePath.make(AppFileSystem.normalizePath(real))
    })

    const registry = makeStrategies({ git, canonical })

    const primary = Effect.fnUntraced(function* (projectID: Project.ID) {
      const row = yield* db
        .select({ path: ProjectPathTable.path })
        .from(ProjectPathTable)
        .where(and(eq(ProjectPathTable.project_id, projectID), eq(ProjectPathTable.primary, true)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new PrimaryPathNotFoundError({ projectID })
      return yield* canonical(AbsolutePath.make(row.path))
    })

    const insert = Effect.fnUntraced(function* (projectID: Project.ID, copyPath: AbsolutePath) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select({ path: ProjectPathTable.path })
                .from(ProjectPathTable)
                .where(and(eq(ProjectPathTable.project_id, projectID), eq(ProjectPathTable.path, copyPath)))
                .get()
              if (row) return false
              yield* tx.insert(ProjectPathTable).values({ project_id: projectID, path: copyPath, primary: false }).run()
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const removeStored = Effect.fnUntraced(function* (projectID: Project.ID, copyPath: AbsolutePath) {
      const row = yield* db
        .select({ path: ProjectPathTable.path })
        .from(ProjectPathTable)
        .where(and(eq(ProjectPathTable.project_id, projectID), eq(ProjectPathTable.path, copyPath)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return false
      yield* db
        .delete(ProjectPathTable)
        .where(and(eq(ProjectPathTable.project_id, projectID), eq(ProjectPathTable.path, copyPath)))
        .run()
        .pipe(Effect.orDie)
      return true
    })

    const changed = Effect.fnUntraced(function* (projectID: Project.ID, update: boolean) {
      if (update) yield* events.publish(Event.Updated, { projectID })
    })

    const strategy = (id: StrategyID) => registry.get(id) as Strategy

    const strategies = Effect.fn("ProjectCopy.strategies")(function* (_input: StrategiesInput) {
      return Array.from(registry.values()).map((strategy) => ({ id: strategy.id, name: strategy.name }))
    })

    const create = Effect.fn("ProjectCopy.create")(function* (input: CreateInput) {
      if (yield* fs.existsSafe(input.path)) return yield* new DestinationExistsError({ path: input.path })
      const result = yield* strategy(input.strategy).create({ ...input, primaryPath: yield* primary(input.projectID) })
      yield* changed(input.projectID, yield* insert(input.projectID, result.path))
      return result
    })

    const remove = Effect.fn("ProjectCopy.remove")(function* (input: RemoveInput) {
      const primaryPath = yield* primary(input.projectID)
      const copyPath = yield* canonical(input.path)
      if (copyPath === primaryPath) {
        return yield* new CannotRemovePrimaryPathError({ projectID: input.projectID, path: copyPath })
      }
      yield* strategy(input.strategy).remove({ ...input, path: copyPath, primaryPath })
      yield* changed(input.projectID, yield* removeStored(input.projectID, copyPath))
    })

    const refresh = Effect.fn("ProjectCopy.refresh")(function* (input: RefreshInput) {
      const primaryPath = yield* primary(input.projectID)
      const strategies = input.strategy ? [strategy(input.strategy)] : Array.from(registry.values())
      const discovered = yield* Effect.forEach(strategies, (strategy) => strategy.list({ ...input, primaryPath }), {
        concurrency: "unbounded",
      }).pipe(Effect.map((sets) => new Set(sets.flatMap((set) => set.map((item) => item.path)))))
      const stored = yield* db
        .select({ path: ProjectPathTable.path, primary: ProjectPathTable.primary })
        .from(ProjectPathTable)
        .where(eq(ProjectPathTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      const inserted = yield* Effect.forEach(discovered, (copyPath) => insert(input.projectID, copyPath)).pipe(
        Effect.map((items) => items.some(Boolean)),
      )
      const removed = yield* Effect.forEach(
        stored.filter((item) => !item.primary),
        (item) =>
          fs.isDir(item.path).pipe(
            Effect.flatMap((exists) =>
              exists ? Effect.succeed(false) : removeStored(input.projectID, AbsolutePath.make(item.path)),
            ),
          ),
      ).pipe(Effect.map((items) => items.some(Boolean)))
      yield* changed(input.projectID, inserted || removed)
    })

    return Service.of({ strategies, create, remove, refresh })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
)
