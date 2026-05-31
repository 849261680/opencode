import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { Git } from "../git"
import { type Copy, type Strategy, type StrategyID } from "./copy"
import type { PathUnavailableError } from "./copy"

export function makeStrategies(input: {
  git: Git.Interface
  canonical: (path: AbsolutePath) => Effect.Effect<AbsolutePath, PathUnavailableError>
}) {
  const repo = (primaryPath: AbsolutePath) => ({ directory: primaryPath, store: primaryPath } satisfies Git.Repo)

  const gitWorktree: Strategy = {
    id: "git_worktree",
    name: "Git worktree",
    create: Effect.fn("ProjectCopy.GitWorktree.create")(function* (options) {
      yield* input.git.worktreeCreate({ repo: repo(options.primaryPath), path: options.path })
      return { path: yield* input.canonical(options.path) }
    }),
    remove: Effect.fn("ProjectCopy.GitWorktree.remove")(function* (options) {
      const entries = yield* gitWorktree.list(options)
      if (!entries.some((entry) => entry.path === options.path)) {
        return yield* new Git.WorktreeError({
          operation: "remove",
          path: options.path,
          message: "Path is not a linked Git worktree",
        })
      }
      yield* input.git.worktreeRemove({ repo: repo(options.primaryPath), path: options.path })
    }),
    list: Effect.fn("ProjectCopy.GitWorktree.list")(function* (options) {
      const entries = yield* input.git.worktreeList(repo(options.primaryPath))
      return yield* Effect.forEach(entries, (entry) =>
        entry === options.primaryPath
          ? Effect.succeed(undefined)
          : input.canonical(entry).pipe(Effect.map((path) => ({ path }))),
      ).pipe(Effect.map((items) => items.filter((item): item is Copy => item !== undefined)))
    }),
  }

  return new Map<StrategyID, Strategy>([[gitWorktree.id, gitWorktree]])
}
