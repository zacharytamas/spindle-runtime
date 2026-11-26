import { describe, expect, it } from "@effect/vitest"
import type { GetMessagesOptions } from "@standardagents/spec"
import { Effect } from "effect"
import * as Statement from "effect/sql/Statement"
import { external, ThreadStore } from "../../src/store/ThreadStore.ts"

import { inMemory, storeAt, toolCalls, user, withDatabaseFile } from "./contract-fixtures.ts"

describe("ThreadStore", () => {
  describe("messages", () => {
    it.effect(
      "each inserted, updated, or deleted row of a thread's messages raises that thread's revision by one",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore
          const thread = yield* store.createThread({ agentId: "assistant" })
          const other = yield* store.createThread({ agentId: "assistant" })
          const revisions = [yield* store.revision(thread.id)]
          const [first] = yield* store.appendMessages(thread.id, [user("first"), user("second")])
          revisions.push(yield* store.revision(thread.id))
          const inserted = yield* store.insertMessage(
            thread.id,
            {
              id: "chosen",
              created_at: 1,
              role: "user",
              content: "x",
            },
            external,
          )
          revisions.push(yield* store.revision(thread.id))
          yield* store.updateMessage(thread.id, first?.id ?? "", { content: "edited" }, external)
          revisions.push(yield* store.revision(thread.id))
          yield* store.deleteMessage(thread.id, "chosen", external)
          revisions.push(yield* store.revision(thread.id))
          const [call] = yield* store.appendMessages(thread.id, [
            { role: "assistant", content: null, tool_calls: toolCalls("a", "b") },
            { role: "tool", content: "ok", tool_call_id: "a" },
            { role: "tool", content: "ok", tool_call_id: "b" },
          ])
          revisions.push(yield* store.revision(thread.id))
          yield* store.deleteMessage(thread.id, call?.id ?? "", external)
          revisions.push(yield* store.revision(thread.id))
          yield* store.appendMessages(other.id, [user("elsewhere")])
          yield* store.deleteMessage(thread.id, "missing", external)
          revisions.push(yield* store.revision(thread.id))
          expect(revisions).toEqual([0, 2, 3, 4, 5, 8, 11, 11])
          expect(inserted.revision).toBe(3)
          expect(yield* store.revision(other.id)).toBe(1)
          expect((yield* Effect.flip(store.revision("missing")))._tag).toBe("ThreadNotFound")
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("a message write inside a transaction that rolls back leaves the revision as it was", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [kept] = yield* store.appendMessages(thread.id, [user("kept")])
        const id = kept?.id ?? ""
        const writes: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
          store.appendMessages(thread.id, [user("appended")]),
          store.insertMessage(thread.id, { id: "inserted", created_at: 1, role: "user", content: "x" }, external),
          store.updateMessage(thread.id, id, { content: "edited" }, external),
          store.deleteMessage(thread.id, id, external),
        ]
        for (const write of writes)
          expect(yield* Effect.flip(store.transaction(Effect.andThen(write, Effect.fail("crash"))))).toBe("crash")
        expect(yield* store.history(thread.id)).toEqual({
          revision: 1,
          messages: [kept],
          positions: new Map([[id, { seq: 1, callerSeq: null }]]),
        })
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("insertMessage reports the revision after its insert, and none inside a caller's transaction", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const alone = yield* store.insertMessage(
          thread.id,
          { id: "alone", created_at: 1, role: "user", content: "x" },
          external,
        )
        const nested = yield* store.transaction(
          store.insertMessage(thread.id, { id: "nested", created_at: 2, role: "user", content: "y" }, external),
        )
        expect([alone.revision, nested.revision, yield* store.revision(thread.id)]).toEqual([1, null, 2])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "history reads every message oldest first with the revision they match, and sees another connection",
      () =>
        withDatabaseFile((filename) =>
          Effect.gen(function* () {
            const store = yield* ThreadStore
            const thread = yield* store.createThread({ agentId: "assistant" })
            yield* store.appendMessages(thread.id, [user("first"), user("quiet", { silent: true })])
            const before = yield* store.history(thread.id)
            yield* Effect.gen(function* () {
              const other = yield* ThreadStore
              yield* other.appendMessages(thread.id, [user("from another connection")])
            }).pipe(Effect.provide(storeAt(filename)))
            const after = yield* store.history(thread.id)
            expect({ revision: before.revision, contents: before.messages.map((m) => m.content) }).toEqual({
              revision: 2,
              contents: ["first", "quiet"],
            })
            expect(yield* store.revision(thread.id)).toBe(3)
            expect({ revision: after.revision, contents: after.messages.map((m) => m.content) }).toEqual({
              revision: 3,
              contents: ["first", "quiet", "from another connection"],
            })
            expect((yield* Effect.flip(store.history("missing")))._tag).toBe("ThreadNotFound")
          }).pipe(Effect.provide(storeAt(filename))),
        ),
    )

    it.effect("getMessages orders newest first by default and pages with limit and offset", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* store.appendMessages(
          thread.id,
          ["m1", "m2", "m3", "m4", "m5"].map((c) => user(c)),
        )
        const page = (options: Parameters<typeof store.getMessages>[1]) =>
          Effect.map(store.getMessages(thread.id, options), (r) => ({
            contents: r.messages.map((m) => m.content),
            total: r.total,
            hasMore: r.hasMore,
          }))
        expect(yield* page({})).toEqual({ contents: ["m5", "m4", "m3", "m2", "m1"], total: 5, hasMore: false })
        expect(yield* page({ order: "asc", limit: 2 })).toEqual({ contents: ["m1", "m2"], total: 5, hasMore: true })
        expect(yield* page({ order: "asc", limit: 2, offset: 2 })).toEqual({
          contents: ["m3", "m4"],
          total: 5,
          hasMore: true,
        })
        expect(yield* page({ limit: 2, offset: 4 })).toEqual({ contents: ["m1"], total: 5, hasMore: false })
        expect(yield* page({ order: "desc", limit: 2 })).toEqual({ contents: ["m5", "m4"], total: 5, hasMore: true })
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("getMessages counts and pages from one snapshot while another connection inserts between the reads", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const writer = yield* ThreadStore
          const thread = yield* writer.createThread({ agentId: "assistant" })
          yield* writer.appendMessages(thread.id, [user("first")])
          let inserted = false
          const insertBeforePage: Statement.Transformer = (statement) => {
            if (inserted || !statement.compile()[0].includes("ORDER BY seq")) return Effect.succeed(statement)
            inserted = true
            return Effect.as(Effect.orDie(writer.appendMessages(thread.id, [user("second")])), statement)
          }
          const read = yield* Effect.gen(function* () {
            const reader = yield* ThreadStore
            return yield* reader
              .getMessages(thread.id)
              .pipe(Effect.provideService(Statement.CurrentTransformer, insertBeforePage))
          }).pipe(Effect.provide(storeAt(filename)))
          expect(inserted).toBe(true)
          expect({ contents: read.messages.map((m) => m.content), total: read.total, hasMore: read.hasMore }).toEqual({
            contents: ["first"],
            total: 1,
            hasMore: false,
          })
          expect((yield* writer.getMessages(thread.id)).total).toBe(2)
        }).pipe(Effect.provide(storeAt(filename))),
      ),
    )

    it.effect(
      "getMessages fails with InvalidMessagesQuery for a limit or offset that is not a non-negative integer",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore
          const thread = yield* store.createThread({ agentId: "assistant" })
          yield* store.appendMessages(thread.id, [user("m1"), user("m2"), user("m3")])
          const invalid: Array<[keyof GetMessagesOptions, number]> = [
            ["limit", -5],
            ["limit", 2.5],
            ["limit", Number.NaN],
            ["offset", -1],
            ["offset", 1.5],
          ]
          for (const [option, value] of invalid) {
            const error = yield* Effect.flip(store.getMessages(thread.id, { [option]: value }))
            expect(error).toMatchObject({ _tag: "InvalidMessagesQuery", option, value })
            expect(error.message).toContain(option)
          }
          const empty = yield* store.getMessages(thread.id, { limit: 0 })
          expect({ count: empty.messages.length, total: empty.total, hasMore: empty.hasMore }).toEqual({
            count: 0,
            total: 3,
            hasMore: true,
          })
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("getMessages omits silent messages unless includeSilent is true", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [visible, silent] = yield* store.appendMessages(thread.id, [
          user("visible"),
          user("silent", { silent: true }),
        ])
        const ordinary = yield* store.getMessages(thread.id)
        expect(ordinary.messages.map((m) => m.id)).toEqual([visible?.id])
        expect(ordinary.total).toBe(1)
        const all = yield* store.getMessages(thread.id, { includeSilent: true, order: "asc" })
        expect(all.messages.map((m) => m.id)).toEqual([visible?.id, silent?.id])
        expect(all.messages[1]?.silent).toBe(true)
        expect(yield* store.getMessage(thread.id, silent?.id ?? "")).toEqual(silent)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("getMessages with maxDepth omits deeper messages", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* store.appendMessages(thread.id, [user("top"), user("sub", { depth: 1 }), user("subsub", { depth: 2 })])
        const contents = (maxDepth: number) =>
          Effect.map(store.getMessages(thread.id, { maxDepth, order: "asc" }), (r) => r.messages.map((m) => m.content))
        expect(yield* contents(0)).toEqual(["top"])
        expect(yield* contents(1)).toEqual(["top", "sub"])
        const all = yield* store.getMessages(thread.id, { order: "asc" })
        expect(all.messages.map((m) => m.content)).toEqual(["top", "sub", "subsub"])
        const page = yield* store.getMessages(thread.id, { maxDepth: 1, limit: 1 })
        expect({ contents: page.messages.map((m) => m.content), total: page.total, hasMore: page.hasMore }).toEqual({
          contents: ["sub"],
          total: 2,
          hasMore: true,
        })
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("getMessages and getMessage never return another thread's messages", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const a = yield* store.createThread({ agentId: "assistant" })
        const b = yield* store.createThread({ agentId: "assistant" })
        const [message] = yield* store.appendMessages(a.id, [user("for a")])
        expect((yield* store.getMessages(b.id)).total).toBe(0)
        expect(yield* store.getMessage(b.id, message?.id ?? "")).toBeNull()
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("getMessages fails with InvalidMessagesQuery for a maxDepth that is not a non-negative integer", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        for (const maxDepth of [-1, 1.5, Number.NaN])
          expect((yield* Effect.flip(store.getMessages(thread.id, { maxDepth })))._tag).toBe("InvalidMessagesQuery")
        expect((yield* store.getMessages(thread.id, { maxDepth: 0 })).total).toBe(0)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("getMessages fails with InvalidMessagesQuery for a limit or offset beyond a safe integer", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        expect((yield* Effect.flip(store.getMessages(thread.id, { limit: 1e20 })))._tag).toBe("InvalidMessagesQuery")
        expect((yield* Effect.flip(store.getMessages(thread.id, { offset: 1e20 })))._tag).toBe("InvalidMessagesQuery")
      }).pipe(Effect.provide(inMemory)),
    )
  })
})
