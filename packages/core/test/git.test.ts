import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import { Effect } from "effect"
import { Git } from "@opencode-ai/core/git"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Git.defaultLayer)

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

describe("Git worktrees", () => {
  it.live("creates, lists, and removes linked worktrees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const worktree = AbsolutePath.make(`${root.path}-git-worktree`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      const repo = { directory, store: AbsolutePath.make(`${directory}/.git`) }

      yield* git.worktreeCreate({ repo, path: worktree })

      expect((yield* git.worktreeList(repo)).some((entry) => entry.endsWith("-git-worktree"))).toBe(true)
      yield* git.worktreeRemove({ repo, path: worktree })
      expect((yield* git.worktreeList(repo)).some((entry) => entry.endsWith("-git-worktree"))).toBe(false)
    }),
  )
})
