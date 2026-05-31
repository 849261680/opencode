export * as Git from "./git"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AbsolutePath } from "./schema"
import { AppFileSystem } from "./filesystem"
import { AppProcess } from "./process"

export interface Repo {
  /**
   * The root directory of the working tree that contains the input path.
   *
   * For `/home/me/app/src/file.ts` in a normal clone, this is `/home/me/app`.
   * For `/home/me/app-feature/src/file.ts` in a linked worktree, this is
   * `/home/me/app-feature`.
   */
  readonly directory: AbsolutePath
  /**
   * The shared Git storage directory used by this repo and any linked worktrees.
   *
   * For a normal clone at `/home/me/app`, this is usually `/home/me/app/.git`.
   * For a linked worktree at `/home/me/app-feature` whose main checkout is
   * `/home/me/app`, this is usually `/home/me/app/.git`.
   */
  readonly store: AbsolutePath
}

export class WorktreeError extends Schema.TaggedErrorClass<WorktreeError>()("Git.WorktreeError", {
  operation: Schema.Literals(["create", "remove", "list"]),
  message: Schema.String,
  path: Schema.optional(AbsolutePath),
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly find: (input: AbsolutePath) => Effect.Effect<Repo | undefined>
  readonly remote: (repo: Repo, name?: string) => Effect.Effect<string | undefined>
  readonly roots: (repo: Repo) => Effect.Effect<string[]>
  readonly worktreeCreate: (input: { repo: Repo; path: AbsolutePath }) => Effect.Effect<void, WorktreeError>
  readonly worktreeRemove: (input: { repo: Repo; path: AbsolutePath }) => Effect.Effect<void, WorktreeError>
  readonly worktreeList: (repo: Repo) => Effect.Effect<AbsolutePath[], WorktreeError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GitV2") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const proc = yield* AppProcess.Service

    const find = Effect.fn("Git.find")(function* (input: AbsolutePath) {
      const dotgit = yield* fs.up({ targets: [".git"], start: input }).pipe(
        Effect.map((matches) => matches[0]),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!dotgit) return undefined

      const cwd = path.dirname(dotgit)
      const git = run(cwd, proc)
      const topLevel = yield* git(["rev-parse", "--show-toplevel"])
      const commonDir = yield* git(["rev-parse", "--git-common-dir"])
      if (commonDir.exitCode !== 0) return undefined

      return {
        directory: AbsolutePath.make(topLevel.exitCode === 0 ? resolvePath(cwd, topLevel.text) : cwd),
        store: AbsolutePath.make(resolvePath(cwd, commonDir.text)),
      } satisfies Repo
    })

    const remote = Effect.fn("Git.remote")(function* (repo: Repo, name = "origin") {
      const result = yield* run(repo.directory, proc)(["remote", "get-url", name])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const roots = Effect.fn("Git.roots")(function* (repo: Repo) {
      const result = yield* run(repo.directory, proc)(["rev-list", "--max-parents=0", "HEAD"])
      if (result.exitCode !== 0) return []
      return result.text
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .toSorted()
    })

    const worktree = Effect.fnUntraced(function* (
      operation: "create" | "remove" | "list",
      repo: Repo,
      args: string[],
      worktreePath?: AbsolutePath,
    ) {
      const result = yield* proc
        .run(ChildProcess.make("git", args, { cwd: repo.directory, extendEnv: true, stdin: "ignore" }))
        .pipe(
          Effect.mapError(
            (cause) => new WorktreeError({ operation, path: worktreePath, message: cause.message, cause }),
          ),
        )
      if (result.exitCode === 0) return result.stdout.toString("utf8")
      return yield* new WorktreeError({
        operation,
        path: worktreePath,
        message: result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || "Git failed",
      })
    })

    const worktreeCreate = Effect.fn("Git.worktreeCreate")(function* (input: { repo: Repo; path: AbsolutePath }) {
      yield* worktree("create", input.repo, ["worktree", "add", "--detach", input.path, "HEAD"], input.path)
    })

    const worktreeRemove = Effect.fn("Git.worktreeRemove")(function* (input: { repo: Repo; path: AbsolutePath }) {
      yield* worktree("remove", input.repo, ["worktree", "remove", "--force", input.path], input.path)
    })

    const worktreeList = Effect.fn("Git.worktreeList")(function* (repo: Repo) {
      return (yield* worktree("list", repo, ["worktree", "list", "--porcelain"]))
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => AbsolutePath.make(resolvePath(repo.directory, line.slice("worktree ".length).trim())))
    })

    return Service.of({ find, remote, roots, worktreeCreate, worktreeRemove, worktreeList })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
)

interface Result {
  readonly exitCode: number
  readonly text: string
}

function run(cwd: string, proc: AppProcess.Interface) {
  return (args: string[]) =>
    proc
      .run(
        ChildProcess.make("git", args, {
          cwd,
          extendEnv: true,
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.map((result) => ({ exitCode: result.exitCode, text: result.stdout.toString("utf8") }) satisfies Result),
        Effect.catch(() => Effect.succeed({ exitCode: 1, text: "" } satisfies Result)),
      )
}

function resolvePath(cwd: string, value: string) {
  const trimmed = value.replace(/[\r\n]+$/, "")
  if (!trimmed) return cwd
  const normalized = AppFileSystem.windowsPath(trimmed)
  if (path.isAbsolute(normalized)) return path.normalize(normalized)
  return path.resolve(cwd, normalized)
}
