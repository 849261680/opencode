import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { Auth } from "@opencode-ai/core/auth"
import { EventV2 } from "@opencode-ai/core/event"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

function authLayer(dir: string) {
  return Auth.layer.pipe(
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provide(
      Global.layerWith({
        data: dir,
        cache: path.join(dir, "cache"),
        config: path.join(dir, "config"),
        state: path.join(dir, "state"),
        tmp: path.join(dir, "tmp"),
        bin: path.join(dir, "bin"),
        log: path.join(dir, "log"),
        repos: path.join(dir, "repos"),
      }),
    ),
  )
}

describe("Auth", () => {
  it.live("stores api credentials", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          const account = yield* auth.create({
            serviceID: Auth.ServiceID.make("anthropic"),
            credential: new Auth.ApiKeyCredential({ type: "api", key: "sk-test" }),
          })
          if (!account) throw new Error("expected account")

          const active = yield* auth.active(Auth.ServiceID.make("anthropic"))
          expect(active?.id).toBe(account.id)
          expect(active?.credential).toEqual({ type: "api", key: "sk-test" })
        }).pipe(Effect.provide(authLayer(tmp.path))),
      ),
    ),
  )
})
