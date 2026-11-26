import { describe, expect, it } from "@effect/vitest"
import { defineHook, type Message } from "@standardagents/spec"
import { Effect, Fiber, Layer } from "effect"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { project } from "../../../conformance/src/scenarios/step-loop.ts"
import { argumentWatcher } from "../../src/execution/call.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage } from "../../src/execution/trigger.ts"
import { layer } from "../../src/store/sqlite.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf } from "../spindle-driver.ts"

const feed = (key: string, deltas: ReadonlyArray<string>) => {
  const watch = argumentWatcher(key)
  return deltas.map((delta) => watch(delta))
}

describe("argumentWatcher", () => {
  it("returns a string value once its closing quote arrives, one character at a time", () => {
    const text = '{"description": "say \\"hi\\" \\\\", "content": "x"}'
    const results = feed("description", [...text])
    const index = results.findIndex((result) => result !== undefined)
    expect(results[index]).toEqual({ value: 'say "hi" \\' })
    expect(text.slice(0, index + 1)).toBe('{"description": "say \\"hi\\" \\\\"')
  })

  it("skips a nested object that holds the same key and quotes and braces in strings", () => {
    const text = '{"meta": {"description": "inner", "s": "}{]["}, "list": ["a", {"b": 1}], "description": "outer"}'
    expect(feed("description", [text])).toEqual([{ value: "outer" }])
  })

  it("returns a number only when a delimiter ends it and an object when its brace closes", () => {
    expect(feed("n", ['{"n": 12', "3", ', "m": 1}'])).toEqual([undefined, undefined, { value: 123 }])
    expect(feed("n", ['{"n": 4}'])).toEqual([{ value: 4 }])
    expect(feed("o", ['{"o": {"a": [1, "}"]', "}"])).toEqual([undefined, { value: { a: [1, "}"] } }])
  })

  it("returns nothing for a key that never appears", () => {
    expect(feed("description", ['{"content": "a"', ', "path": "b"}'])).toEqual([undefined, undefined])
  })
})

// Terminate and an abort interrupt an execution. A hook that is running then must leave no partial write behind.
describe("an interrupted hook", () => {
  const run = (position: "before_create_message" | "after_create_message") =>
    Effect.gen(function* () {
      let entered: () => void = () => {}
      const inside = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: () => void
      const cleanup = new Promise<void>((resolve) => {
        release = resolve
      })
      const hang = defineHook({
        hook: position,
        id: "hang",
        execute: (async (_state: unknown, message: Message) => {
          if (message.role === "assistant") {
            entered()
            await cleanup
          }
          return message
        }) as never,
      })
      const provider = new ScriptedProvider([{ text: "reply" }])
      const registry = registryOf(project({ provider, hooks: [hang], prompt: { hooks: ["hang"] } }))
      const store = Layer.fresh(layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" }))))
      return yield* Effect.gen(function* () {
        const threads = yield* ThreadStore
        const supervisor = yield* ThreadSupervisor
        const thread = yield* createThread("assistant")
        const fiber = yield* Effect.forkChild(sendMessage(thread.id, "go"))
        yield* Effect.promise(() => inside)
        yield* supervisor.abort(thread.id)
        expect((yield* threads.getThread(thread.id)).status.state).toBe("running")
        release()
        yield* Fiber.join(fiber)
        const stored = (yield* threads.getMessages(thread.id, { order: "asc", includeSilent: true })).messages
        yield* threads.transaction(threads.appendMessages(thread.id, [{ role: "user", content: "later" }]))
        const after = (yield* threads.getMessages(thread.id, { order: "asc", includeSilent: true })).messages
        return { stored: stored.map((m) => m.content), after: after.map((m) => m.content) }
      }).pipe(Effect.provide(Layer.merge(registry, Layer.provideMerge(supervisorLayer(), store))))
    })

  it.effect("in before_create_message stores nothing of the message and leaves no transaction open", () =>
    Effect.gen(function* () {
      expect(yield* run("before_create_message")).toEqual({ stored: ["go"], after: ["go", "later"] })
    }),
  )

  it.effect("in after_create_message keeps the whole stored message and leaves no transaction open", () =>
    Effect.gen(function* () {
      expect(yield* run("after_create_message")).toEqual({ stored: ["go", "reply"], after: ["go", "reply", "later"] })
    }),
  )
})
