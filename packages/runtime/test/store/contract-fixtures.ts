import { Effect, FileSystem, Layer } from "effect"
import { PlatformLive, SqliteLive } from "#platform"
import type { NewMessage } from "../../src/store/model.ts"
import { layer } from "../../src/store/sqlite.ts"

// Effect.provide reuses a layer that an enclosing provide already built, so a nested store would share its connection.
export const storeAt = (filename: string) => Layer.fresh(layer.pipe(Layer.provideMerge(SqliteLive({ filename }))))

export const claim = { holder: "fixture", flowId: "fixture-flow" }

export const inMemory = storeAt(":memory:")

export const withDatabaseFile = <A, E, R>(use: (filename: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-store-" })
    return yield* use(`${dir}/spindle.db`)
  }).pipe(Effect.scoped, Effect.provide(PlatformLive))

export const user = (content: string, extra: Partial<NewMessage> = {}): NewMessage => ({
  role: "user",
  content,
  ...extra,
})

export const toolCalls = (...ids: Array<string>) =>
  JSON.stringify(ids.map((id) => ({ id, type: "function", function: { name: "lookup", arguments: "{}" } })))
