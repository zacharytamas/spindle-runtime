import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqliteLive } from "#platform"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { layer } from "../../src/store/sqlite.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"

const inMemory = Layer.fresh(layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" }))))

describe("ThreadStore without a fence", () => {
  // takeQueue deletes a batch of entries and hands the only copy to its caller. setStatus writes a run status and
  // enqueue adds an entry without a look at the claim. Nothing in the runtime calls them, so the store has no need
  // to offer them. The names are read from the service at run time, so this test names no member that must exist.
  it.effect("offers no takeQueue, no raw setStatus, and no raw enqueue", () =>
    Effect.gen(function* () {
      const store: object = { ...(yield* ThreadStore), ...(yield* MessageStore), ...(yield* RunStore) }
      expect(["takeQueue", "setStatus", "enqueue"].filter((name) => name in store)).toEqual([])
    }).pipe(Effect.provide(inMemory)),
  )
})
