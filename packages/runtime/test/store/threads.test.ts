import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { TestClock } from "effect/testing"
import { platformName } from "#platform"
import { ThreadStore } from "../../src/store/ThreadStore.ts"

import { inMemory, storeAt, withDatabaseFile } from "./contract-fixtures.ts"

const epochDate = new Date(0)

describe("ThreadStore", () => {
  describe("threads", () => {
    it.effect("createThread stores the agent, the parent, and the arguments, and starts idle with since 0", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const parent = yield* store.createThread({ agentId: "triage" })
        const child = yield* store.createThread({
          agentId: "billing",
          parentId: parent.id,
          arguments: { shirt_size: "L" },
        })
        expect(yield* store.getThread(child.id)).toEqual({
          id: child.id,
          agentId: "billing",
          parentId: parent.id,
          arguments: { shirt_size: "L" },
          createdAt: child.createdAt,
          terminated: null,
          status: { state: "idle", since: 0, reason: null },
        })
        expect(parent.id).not.toBe(child.id)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("createThread fails with ThreadNotFound when the parent does not exist", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const error = yield* Effect.flip(store.createThread({ agentId: "billing", parentId: "missing" }))
        expect(error._tag).toBe("ThreadNotFound")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("getThread fails with ThreadNotFound for an unknown id", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const error = yield* Effect.flip(store.getThread("missing"))
        expect(error).toMatchObject({ _tag: "ThreadNotFound", threadId: "missing" })
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("terminate sets the terminated time once and keeps it on a second call", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* TestClock.adjust("1 second")
        const terminated = yield* store.terminate(thread.id)
        yield* TestClock.adjust("1 second")
        expect(yield* store.terminate(thread.id)).toBe(terminated)
        expect((yield* store.getThread(thread.id)).terminated).toBe(1_000_000)
      }).pipe(Effect.provide(inMemory)),
    )
  })

  describe("key-value store", () => {
    it.effect("setValue makes a value visible to every later getValue on the same thread", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* store.setValue(thread.id, "invocation_count", 1)
        expect(yield* store.getValue(thread.id, "invocation_count")).toBe(1)
        yield* store.setValue(thread.id, "invocation_count", 2)
        expect(yield* store.getValue(thread.id, "invocation_count")).toBe(2)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("values round-trip with JSON structure", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const values = {
          object: { theme: "dark", nested: { list: [1, "two", false, null, { deep: true }] } },
          array: [1, 2, 3],
          string: "hello",
          number: 3.25,
          zero: 0,
          boolean: false,
          empty: "",
        }
        for (const [key, value] of Object.entries(values)) yield* store.setValue(thread.id, key, value)
        for (const [key, value] of Object.entries(values)) expect(yield* store.getValue(thread.id, key)).toEqual(value)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("getValue returns null for a key that was never set, on a thread whose store was never written", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        expect(yield* store.getValue(thread.id, "never")).toBeNull()
        yield* store.setValue(thread.id, "other", 1)
        expect(yield* store.getValue(thread.id, "never")).toBeNull()
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("setValue with null or undefined deletes the key", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* store.setValue(thread.id, "a", { x: 1 })
        yield* store.setValue(thread.id, "b", [1])
        yield* store.setValue(thread.id, "a", null)
        yield* store.setValue(thread.id, "b", undefined)
        expect(yield* store.getValue(thread.id, "a")).toBeNull()
        expect(yield* store.getValue(thread.id, "b")).toBeNull()
        yield* store.setValue(thread.id, "a", "again")
        expect(yield* store.getValue(thread.id, "a")).toBe("again")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("a thread reads only its own keys, not those of its parent, child, or sibling", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const parent = yield* store.createThread({ agentId: "triage" })
        const child = yield* store.createThread({ agentId: "billing", parentId: parent.id })
        const sibling = yield* store.createThread({ agentId: "support", parentId: parent.id })
        const lonely = yield* store.createThread({ agentId: "support", parentId: parent.id })
        for (const thread of [parent, child, sibling]) yield* store.setValue(thread.id, "owner", thread.agentId)
        expect(yield* store.getValue(parent.id, "owner")).toBe("triage")
        expect(yield* store.getValue(child.id, "owner")).toBe("billing")
        expect(yield* store.getValue(sibling.id, "owner")).toBe("support")
        expect(yield* store.getValue(lonely.id, "owner")).toBeNull()
        yield* store.setValue(child.id, "owner", null)
        expect(yield* store.getValue(parent.id, "owner")).toBe("triage")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "setValue rejects a value JSON cannot represent with an error that names the key, and stores nothing",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore
          const thread = yield* store.createThread({ agentId: "assistant" })
          const circular: Record<string, unknown> = {}
          circular.self = circular
          const rejected = [
            10n,
            { nested: { count: 10n } },
            Number.NaN,
            Number.POSITIVE_INFINITY,
            () => 1,
            Symbol("s"),
            [1, undefined],
            epochDate,
            new Map(),
            circular,
          ]
          for (const [index, value] of rejected.entries()) {
            const key = `bad-${index}`
            const error = yield* Effect.flip(store.setValue(thread.id, key, value))
            expect(error._tag).toBe("ValueNotJson")
            expect(error.message).toContain(`"${key}"`)
            expect(yield* store.getValue(thread.id, key)).toBeNull()
          }
          yield* store.setValue(thread.id, "kept", 1)
          yield* Effect.flip(store.setValue(thread.id, "kept", 10n))
          expect(yield* store.getValue(thread.id, "kept")).toBe(1)
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("setValue accepts a plain object that carries a Symbol.toStringTag", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* store.setValue(thread.id, "tagged", { a: 1, [Symbol.toStringTag]: "Sample" })
        expect(yield* store.getValue(thread.id, "tagged")).toEqual({ a: 1 })
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("setValue rejects an object whose prototype could serialize it differently from its members", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        class Money {
          amount = 5
          toJSON() {
            return "five"
          }
        }
        const inherited = Object.create({ toJSON: () => "ok" }, { a: { value: 1, enumerable: true } })
        const rootWithToJson = Object.assign(
          Object.create(Object.assign(Object.create(null), { toJSON: () => "ok" })),
          {
            a: 1,
          },
        )
        const throwingPrototype = Object.create(
          new Proxy(
            {},
            {
              get: () => {
                throw new Error("trap")
              },
            },
          ),
        )
        for (const value of [new Money(), inherited, epochDate, new Map(), rootWithToJson, throwingPrototype]) {
          const error = yield* Effect.flip(store.setValue(thread.id, "odd", value))
          expect(error._tag).toBe("ValueNotJson")
        }
        expect(yield* store.getValue(thread.id, "odd")).toBe(null)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("setValue accepts a plain object whose prototype is not this realm's Object.prototype", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        // Another realm's Object.prototype is a root object that is not this realm's, which a fresh root stands in for.
        const foreign = Object.assign(Object.create(Object.create(null)), { x: 1, nested: [{ y: "z" }] })
        const bare = Object.assign(Object.create(null), { x: 2 })
        yield* store.setValue(thread.id, "foreign", foreign)
        yield* store.setValue(thread.id, "bare", bare)
        expect(yield* store.getValue(thread.id, "foreign")).toEqual({ x: 1, nested: [{ y: "z" }] })
        expect(yield* store.getValue(thread.id, "bare")).toEqual({ x: 2 })
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("setValue stores the value it validated, even when the caller changes it before the write runs", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const value: { x: number } = { x: 1 }
        const write = store.setValue(thread.id, "changed", value)
        value.x = Number.POSITIVE_INFINITY
        expect(yield* Effect.flip(write)).toMatchObject({ _tag: "ValueNotJson", path: "$.x", found: "Infinity" })
        expect(yield* store.getValue(thread.id, "changed")).toBeNull()
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "setValue fails with ValueNotJson, not a thrown error, for a getter that throws or a value nested too deep",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore
          const thread = yield* store.createThread({ agentId: "assistant" })
          const nest = (levels: number) => {
            let value: unknown = "leaf"
            for (let n = 0; n < levels; n++) value = { a: value }
            return value
          }
          const throwing = {
            get broken(): never {
              throw new Error("boom")
            },
          }
          const getter = yield* Effect.flip(store.setValue(thread.id, "getter", throwing))
          expect(getter).toMatchObject({ _tag: "ValueNotJson", path: "$" })
          expect(getter.message).toContain("boom")
          const deep = yield* Effect.flip(store.setValue(thread.id, "deep", nest(20_000)))
          expect(deep).toMatchObject({ _tag: "ValueNotJson" })
          expect(deep.message).toContain("1000 levels")
          yield* store.setValue(thread.id, "deepest", nest(1000))
          expect(JSON.stringify(yield* store.getValue(thread.id, "deepest"))).toBe(JSON.stringify(nest(1000)))
          expect(yield* Effect.flip(store.setValue(thread.id, "too deep", nest(1001)))).toMatchObject({
            _tag: "ValueNotJson",
          })
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("values survive the exit of the process that wrote them", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          const probe = new URL("../../scripts/store-probe.ts", import.meta.url).pathname
          const output = yield* spawner.lines(
            ChildProcess.make(platformName, ["--conditions=spindle-source", probe, "kv-write", "--db", filename]),
          )
          const written = JSON.parse(output.at(-1) ?? "null")
          expect(written).toMatchObject({ runtime: platformName, key: "preferences" })
          const value = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            return yield* store.getValue(written.thread, written.key)
          }).pipe(Effect.provide(storeAt(filename)))
          expect(value).toEqual({ theme: "dark", locale: "en-US" })
          expect(value).toEqual(written.value)
        }),
      ),
    )

    it.effect(
      "a value is committed when setValue resolves, so a second connection reads it while the first stays open",
      () =>
        withDatabaseFile((filename) =>
          Effect.gen(function* () {
            const writer = yield* ThreadStore
            const thread = yield* writer.createThread({ agentId: "assistant" })
            yield* writer.setValue(thread.id, "count", 1)
            const read = Effect.gen(function* () {
              const reader = yield* ThreadStore
              return yield* reader.getValue(thread.id, "count")
            }).pipe(Effect.provide(storeAt(filename)))
            expect(yield* read).toBe(1)
            yield* writer.setValue(thread.id, "count", null)
            expect(yield* read).toBeNull()
          }).pipe(Effect.provide(storeAt(filename))),
        ),
    )

    it.effect("a key that is not well-formed Unicode fails with KeyNotWellFormed and never aliases another key", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* store.setValue(thread.id, "\ufffd", "replacement character")
        yield* store.setValue(thread.id, "\ud83d\ude00", "emoji")
        for (const key of ["\ud800", "\udc00", "a\ud801b"]) {
          for (const call of [
            store.setValue(thread.id, key, 1),
            store.setValue(thread.id, key, null),
            store.getValue(thread.id, key),
          ]) {
            const error = yield* Effect.flip(call)
            expect(error).toMatchObject({ _tag: "KeyNotWellFormed", key })
            expect(error.message).toContain("lone surrogate")
          }
        }
        expect(yield* store.getValue(thread.id, "\ufffd")).toBe("replacement character")
        expect(yield* store.getValue(thread.id, "\ud83d\ude00")).toBe("emoji")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("setValue fails with ThreadNotFound for an unknown thread, whether it writes or deletes", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        for (const value of [1, { a: 1 }, null, undefined]) {
          const error = yield* Effect.flip(store.setValue("missing", "k", value))
          expect(error).toMatchObject({ _tag: "ThreadNotFound", threadId: "missing" })
        }
      }).pipe(Effect.provide(inMemory)),
    )
  })
})
