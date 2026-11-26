import { describe, expect, it } from "@effect/vitest"
import type { GetMessagesOptions } from "@standardagents/spec"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Statement from "effect/sql/Statement"
import { TestClock } from "effect/testing"
import { PlatformLive, platformName, SqliteLive } from "#platform"
import { layer } from "../../src/store/sqlite.ts"
import { type NewMessage, ThreadStore } from "../../src/store/ThreadStore.ts"

// Effect.provide reuses a layer that an enclosing provide already built, so a nested store would share its connection.
const storeAt = (filename: string) => Layer.fresh(layer.pipe(Layer.provide(SqliteLive({ filename }))))
const inMemory = storeAt(":memory:")

const withDatabaseFile = <A, E, R>(use: (filename: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-store-" })
    return yield* use(`${dir}/spindle.db`)
  }).pipe(Effect.scoped, Effect.provide(PlatformLive))

const user = (content: string, extra: Partial<NewMessage> = {}): NewMessage => ({ role: "user", content, ...extra })

const toolCalls = (...ids: Array<string>) =>
  JSON.stringify(ids.map((id) => ({ id, type: "function", function: { name: "lookup", arguments: "{}" } })))

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

  describe("run status", () => {
    it.effect("setStatus changes since only when the state or the reason changes", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* TestClock.adjust("1 second")
        const running = yield* store.setStatus(thread.id, { state: "running" })
        expect(running).toEqual({ state: "running", since: 1_000_000, reason: null })
        yield* TestClock.adjust("1 second")
        expect(yield* store.setStatus(thread.id, { state: "running" })).toEqual(running)
        yield* TestClock.adjust("1 second")
        const idle = yield* store.setStatus(thread.id, { state: "idle", reason: "stop_on_response" })
        expect(idle).toEqual({ state: "idle", since: 3_000_000, reason: "stop_on_response" })
        yield* TestClock.adjust("1 second")
        expect(yield* store.setStatus(thread.id, { state: "idle", reason: "stop_on_response" })).toEqual(idle)
        yield* TestClock.adjust("1 second")
        const stopTool = yield* store.setStatus(thread.id, { state: "idle", reason: "stop_tool" })
        expect(stopTool).toEqual({ state: "idle", since: 5_000_000, reason: "stop_tool" })
        expect((yield* store.getThread(thread.id)).status).toEqual(stopTool)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("the run status survives a restart with its since time, including a failed execution_lost status", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const written = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            const thread = yield* store.createThread({ agentId: "assistant" })
            yield* TestClock.adjust("1 second")
            yield* store.setStatus(thread.id, { state: "running" })
            yield* TestClock.adjust("1 second")
            const status = yield* store.setStatus(thread.id, { state: "failed", reason: "execution_lost" })
            return { threadId: thread.id, status }
          }).pipe(Effect.provide(storeAt(filename)))
          expect(written.status).toEqual({ state: "failed", since: 2_000_000, reason: "execution_lost" })
          yield* TestClock.adjust("1 second")
          const status = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            return (yield* store.getThread(written.threadId)).status
          }).pipe(Effect.provide(storeAt(filename)))
          expect(status).toEqual(written.status)
        }),
      ),
    )
  })

  describe("messages", () => {
    it.effect("appendMessages returns the stored records and getMessage reads each one back", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [assistant] = yield* store.appendMessages(thread.id, [
          {
            role: "assistant",
            content: null,
            tool_calls: toolCalls("call-1"),
            reasoning_content: "The user wants a lookup.",
            reasoning_details: '[{"type":"summary"}]',
            prompt: "assistant_prompt",
            status: "completed",
            metadata: { step: 1 },
          },
        ])
        expect(assistant).toBeDefined()
        expect(yield* store.getMessage(thread.id, assistant?.id ?? "")).toEqual({
          id: assistant?.id,
          role: "assistant",
          content: null,
          name: null,
          tool_calls: toolCalls("call-1"),
          tool_call_id: null,
          tool_status: null,
          status: "completed",
          attachments: null,
          reasoning_content: "The user wants a lookup.",
          reasoning_details: '[{"type":"summary"}]',
          prompt: "assistant_prompt",
          created_at: assistant?.created_at,
          parent_id: null,
          depth: 0,
          silent: false,
          metadata: { step: 1 },
          subagent_id: null,
          subagent_relationship: null,
          subagent_name: null,
          subagent_title: null,
          subagent_description: null,
          subagent_status: null,
          subagent_blocking: null,
          subagent_thread_name: null,
          subagent_spawn_group_id: null,
        })
        expect(yield* store.getMessage(thread.id, "missing")).toBeNull()
        const [plain] = yield* store.appendMessages(thread.id, [user("no reasoning here")])
        expect(yield* store.getMessage(thread.id, plain?.id ?? "")).toMatchObject({
          reasoning_content: null,
          reasoning_details: null,
        })
        expect((yield* store.getMessages(thread.id, { order: "asc" })).messages).toEqual([
          yield* store.getMessage(thread.id, assistant?.id ?? ""),
          plain,
        ])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages gives each message a unique id and its creation time in microseconds", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* TestClock.adjust("1500 millis")
        const first = yield* store.appendMessages(thread.id, [user("a"), user("b")])
        yield* TestClock.adjust("1 second")
        const second = yield* store.appendMessages(thread.id, [user("c")])
        const read = (yield* store.getMessages(thread.id, { order: "asc" })).messages
        expect(read.map((m) => m.created_at)).toEqual([1_500_000, 1_500_000, 2_500_000])
        expect(new Set(read.map((m) => m.id)).size).toBe(3)
        expect(read.map((m) => m.id)).toEqual([...first, ...second].map((m) => m.id))
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages keeps reasoning_content and reasoning_details independently of each other", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const written = yield* store.appendMessages(thread.id, [
          { role: "assistant", content: "a", reasoning_content: "text only" },
          { role: "assistant", content: "b", reasoning_details: '[{"type":"encrypted"}]' },
          { role: "assistant", content: "c" },
        ])
        const read = (yield* store.getMessages(thread.id, { order: "asc" })).messages
        expect(read).toEqual(written)
        expect(read.map((m) => [m.reasoning_content, m.reasoning_details])).toEqual([
          ["text only", null],
          [null, '[{"type":"encrypted"}]'],
          [null, null],
        ])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages keeps each lifecycle status it receives", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* store.appendMessages(thread.id, [
          user("queued", { status: "pending" }),
          user("done", { status: "completed" }),
          user("broken", { status: "failed" }),
          user("plain"),
        ])
        const read = (yield* store.getMessages(thread.id, { order: "asc" })).messages
        expect(read.map((m) => m.status)).toEqual(["pending", "completed", "failed", null])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("a silent message persists across a restart like a visible one", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const written = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            const thread = yield* store.createThread({ agentId: "assistant" })
            const messages = yield* store.appendMessages(thread.id, [user("visible"), user("silent", { silent: true })])
            return { threadId: thread.id, messages }
          }).pipe(Effect.provide(storeAt(filename)))
          const read = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            return yield* store.getMessages(written.threadId, { includeSilent: true, order: "asc" })
          }).pipe(Effect.provide(storeAt(filename)))
          expect(read.messages).toEqual(written.messages)
          expect(read.messages.map((m) => m.silent)).toEqual([false, true])
        }),
      ),
    )

    it.effect("appendMessages stores tool results with their name, call id, and status", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const results = yield* store.appendMessages(thread.id, [
          { role: "tool", content: "42", name: "lookup", tool_call_id: "call-1", tool_status: "success" },
          { role: "tool", content: "timeout", name: "search", tool_call_id: "call-2", tool_status: "error", depth: 1 },
        ])
        const read = yield* store.getMessages(thread.id, { order: "asc" })
        expect(read.messages).toEqual(results)
        expect(read.messages.map((m) => [m.name, m.tool_call_id, m.tool_status, m.depth])).toEqual([
          ["lookup", "call-1", "success", 0],
          ["search", "call-2", "error", 1],
        ])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages writes all records or none when the transaction fails", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const step = store.transaction(
          Effect.gen(function* () {
            yield* store.appendMessages(thread.id, [
              { role: "assistant", content: null, tool_calls: toolCalls("a", "b") },
            ])
            yield* store.appendMessages(thread.id, [{ role: "tool", content: "ok", tool_call_id: "a" }])
            return yield* Effect.fail("tool b crashed" as const)
          }),
        )
        expect(yield* Effect.flip(step)).toBe("tool b crashed")
        expect((yield* store.getMessages(thread.id)).total).toBe(0)
        yield* store.appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: toolCalls("a") },
          { role: "tool", content: "ok", tool_call_id: "a" },
        ])
        expect((yield* store.getMessages(thread.id)).total).toBe(2)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "appendMessages and updateMessage fail with ValueNotJson for a BigInt in metadata and write nothing",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore
          const thread = yield* store.createThread({ agentId: "assistant" })
          const appended = yield* Effect.flip(
            store.appendMessages(thread.id, [user("first"), user("second", { metadata: { count: 10n } })]),
          )
          expect(appended).toMatchObject({ _tag: "ValueNotJson", path: "$.count", found: "a BigInt" })
          expect(appended.message).toContain("metadata")
          expect((yield* store.getMessages(thread.id)).total).toBe(0)
          const [message] = yield* store.appendMessages(thread.id, [user("kept", { metadata: { n: 1 } })])
          const updated = yield* Effect.flip(store.updateMessage(thread.id, message?.id ?? "", { metadata: { n: 2n } }))
          expect(updated).toMatchObject({ _tag: "ValueNotJson", path: "$.n" })
          expect(yield* store.getMessage(thread.id, message?.id ?? "")).toEqual(message)
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages fails with ThreadNotFound and writes nothing for an unknown thread", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const error = yield* Effect.flip(store.appendMessages("missing", [user("hello")]))
        expect(error._tag).toBe("ThreadNotFound")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("each thread keeps its own ordered list of messages across a restart", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const ids = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            const a = yield* store.createThread({ agentId: "assistant" })
            const b = yield* store.createThread({ agentId: "assistant" })
            for (const n of [1, 2, 3]) {
              yield* store.appendMessages(a.id, [user(`a${n}`)])
              yield* store.appendMessages(b.id, [user(`b${n}`)])
            }
            return [a.id, b.id] as const
          }).pipe(Effect.provide(storeAt(filename)))
          const contents = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            return yield* Effect.forEach(ids, (id) =>
              Effect.map(store.getMessages(id, { order: "asc" }), (r) => r.messages.map((m) => m.content)),
            )
          }).pipe(Effect.provide(storeAt(filename)))
          expect(contents).toEqual([
            ["a1", "a2", "a3"],
            ["b1", "b2", "b3"],
          ])
        }),
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

    it.effect("updateMessage replaces the content and merges the metadata", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [message] = yield* store.appendMessages(thread.id, [user("draft", { metadata: { source: "tool" } })])
        const updated = yield* store.updateMessage(thread.id, message?.id ?? "", {
          content: "final",
          metadata: { edited: true },
        })
        expect(updated).toEqual({ ...message, content: "final", metadata: { source: "tool", edited: true } })
        expect(yield* store.getMessage(thread.id, message?.id ?? "")).toEqual(updated)
        const error = yield* Effect.flip(store.updateMessage(thread.id, "missing", { content: "x" }))
        expect(error._tag).toBe("MessageNotFound")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "deleteMessage returns whether it removed a message and removes the tool results of an assistant message",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore
          const thread = yield* store.createThread({ agentId: "assistant" })
          const [, assistant] = yield* store.appendMessages(thread.id, [
            user("look up two things"),
            { role: "assistant", content: null, tool_calls: toolCalls("call-1", "call-2") },
            { role: "tool", content: "1", tool_call_id: "call-1" },
            { role: "tool", content: "2", tool_call_id: "call-2" },
            { role: "tool", content: "other", tool_call_id: "call-3" },
          ])
          expect(yield* store.deleteMessage(thread.id, assistant?.id ?? "")).toBe(true)
          expect(yield* store.deleteMessage(thread.id, assistant?.id ?? "")).toBe(false)
          const left = yield* store.getMessages(thread.id, { order: "asc" })
          expect(left.messages.map((m) => m.content)).toEqual(["look up two things", "other"])
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage keeps the results of a later assistant message that reuses a tool call id", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [first, , second] = yield* store.appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: toolCalls("call_0") },
          { role: "tool", content: "first result", tool_call_id: "call_0" },
          { role: "assistant", content: null, tool_calls: toolCalls("call_0") },
          { role: "tool", content: "second result", tool_call_id: "call_0" },
        ])
        expect(yield* store.deleteMessage(thread.id, first?.id ?? "")).toBe(true)
        const left = yield* store.getMessages(thread.id, { order: "asc" })
        expect(left.messages.map((m) => [m.id === second?.id, m.content])).toEqual([
          [true, null],
          [false, "second result"],
        ])
        expect(yield* store.deleteMessage(thread.id, second?.id ?? "")).toBe(true)
        expect((yield* store.getMessages(thread.id)).total).toBe(0)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage keeps the result of an assistant message under another parent that reuses the id", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [outer, inner] = yield* store.appendMessages(thread.id, [user("outer"), user("inner")])
        const under = (parent: typeof outer) => ({ parent_id: parent?.id ?? null })
        const [, second] = yield* store.appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: toolCalls("shared"), ...under(outer) },
          { role: "assistant", content: null, tool_calls: toolCalls("shared"), ...under(inner) },
          { role: "tool", content: "outer result", tool_call_id: "shared", ...under(outer) },
          { role: "tool", content: "inner result", tool_call_id: "shared", ...under(inner) },
        ])
        expect(yield* store.deleteMessage(thread.id, second?.id ?? "")).toBe(true)
        const left = yield* store.getMessages(thread.id, { order: "asc" })
        expect(left.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["outer result"])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("a leading U+FEFF survives next to a NUL character", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [written] = yield* store.appendMessages(thread.id, [user("\uFEFFa\u0000b")])
        expect((yield* store.getMessage(thread.id, written?.id ?? ""))?.content).toBe("\uFEFFa\u0000b")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("a write returns the record a later read returns when the text holds a lone surrogate", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [written] = yield* store.appendMessages(thread.id, [
          { role: "tool", content: "a\ud800b", name: "n\udc00", tool_call_id: "i\ud800" },
        ])
        expect(written?.content).toBe("a\ufffdb")
        expect(yield* store.getMessage(thread.id, written?.id ?? "")).toEqual(written)
        const updated = yield* store.updateMessage(thread.id, written?.id ?? "", { content: "\ud800" })
        expect(updated.content).toBe("\ufffd")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages returns the parent id a fresh connection reads for a lone surrogate", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const writer = yield* ThreadStore
          const thread = yield* writer.createThread({ agentId: "assistant" })
          const [written] = yield* writer.appendMessages(thread.id, [user("child", { parent_id: "p\ud800" })])
          const read = yield* ThreadStore.use((reader) => reader.getMessage(thread.id, written?.id ?? "")).pipe(
            Effect.provide(storeAt(filename)),
          )
          expect(read?.parent_id).toBe("p\ufffd")
          expect(written?.parent_id).toBe(read?.parent_id)
        }).pipe(Effect.provide(storeAt(filename))),
      ),
    )

    it.effect("deleteMessage removes an assistant message whose tool_calls is not JSON", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [broken] = yield* store.appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: "not json" },
          { role: "tool", content: "kept", tool_call_id: "call_0" },
        ])
        expect(yield* store.deleteMessage(thread.id, broken?.id ?? "")).toBe(true)
        expect((yield* store.getMessages(thread.id)).messages.map((m) => m.content)).toEqual(["kept"])
        const [valid] = yield* store.appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: toolCalls("call_1") },
          { role: "assistant", content: null, tool_calls: "not json" },
          { role: "tool", content: "removed", tool_call_id: "call_1" },
        ])
        expect(yield* store.deleteMessage(thread.id, valid?.id ?? "")).toBe(true)
        const contents = (yield* store.getMessages(thread.id)).messages.map((m) => m.content)
        expect(contents).not.toContain("removed")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "deleteMessage removes an assistant message whose tool_calls array holds an entry that is not an object",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore
          const thread = yield* store.createThread({ agentId: "assistant" })
          const calls = JSON.stringify(["not an envelope", ...JSON.parse(toolCalls("call_1"))])
          const [assistant] = yield* store.appendMessages(thread.id, [
            { role: "assistant", content: null, tool_calls: calls },
            { role: "tool", content: "removed", tool_call_id: "call_1" },
            { role: "tool", content: "kept", tool_call_id: "not an envelope" },
          ])
          expect(yield* store.deleteMessage(thread.id, assistant?.id ?? "")).toBe(true)
          expect((yield* store.getMessages(thread.id)).messages.map((m) => m.content)).toEqual(["kept"])
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "deleteMessage removes the results of an assistant message when a later one holds a non-object entry",
      () =>
        Effect.gen(function* () {
          const store = yield* ThreadStore
          const thread = yield* store.createThread({ agentId: "assistant" })
          const [assistant] = yield* store.appendMessages(thread.id, [
            { role: "assistant", content: null, tool_calls: toolCalls("call_1") },
            { role: "assistant", content: null, tool_calls: JSON.stringify(["not an envelope"]) },
            { role: "tool", content: "removed", tool_call_id: "call_1" },
          ])
          expect(yield* store.deleteMessage(thread.id, assistant?.id ?? "")).toBe(true)
          const left = yield* store.getMessages(thread.id, { order: "asc" })
          expect(left.messages.map((m) => [m.role, m.content])).toEqual([["assistant", null]])
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage removes only the results under its own parent when a parent id holds a NUL", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const survivorAfterDeleting = (parent: "p" | "p\u0000suffix") =>
          Effect.gen(function* () {
            const thread = yield* store.createThread({ agentId: "assistant" })
            const [short, long] = yield* store.appendMessages(thread.id, [
              { role: "assistant", content: null, tool_calls: toolCalls("shared"), parent_id: "p" },
              { role: "assistant", content: null, tool_calls: toolCalls("shared"), parent_id: "p\u0000suffix" },
              { role: "tool", content: "short result", tool_call_id: "shared", parent_id: "p" },
              { role: "tool", content: "long result", tool_call_id: "shared", parent_id: "p\u0000suffix" },
            ])
            const deleted = parent === "p" ? short : long
            expect(yield* store.deleteMessage(thread.id, deleted?.id ?? "")).toBe(true)
            const left = yield* store.getMessages(thread.id, { order: "asc" })
            return left.messages.filter((m) => m.role === "tool").map((m) => m.content)
          })
        expect(yield* survivorAfterDeleting("p\u0000suffix")).toEqual(["short result"])
        expect(yield* survivorAfterDeleting("p")).toEqual(["long result"])
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

    it.effect("updateMessage fails with ValueNotJson when a metadata getter throws", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [written] = yield* store.appendMessages(thread.id, [user("hello")])
        const metadata = {
          get broken(): never {
            throw new Error("getter")
          },
        }
        const error = yield* Effect.flip(store.updateMessage(thread.id, written?.id ?? "", { metadata }))
        expect(error._tag).toBe("ValueNotJson")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage removes the tool results of a user message that lists their call ids", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [first, , second] = yield* store.appendMessages(thread.id, [
          { role: "user", content: "side B call", tool_calls: toolCalls("call-1") },
          { role: "tool", content: "first result", tool_call_id: "call-1" },
          { role: "user", content: "side B again", tool_calls: toolCalls("call-1") },
          { role: "tool", content: "second result", tool_call_id: "call-1" },
        ])
        expect(yield* store.deleteMessage(thread.id, first?.id ?? "")).toBe(true)
        const left = yield* store.getMessages(thread.id, { order: "asc" })
        expect(left.messages.map((m) => m.content)).toEqual(["side B again", "second result"])
        expect(yield* store.deleteMessage(thread.id, second?.id ?? "")).toBe(true)
        expect((yield* store.getMessages(thread.id)).total).toBe(0)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage removes only the record itself for a tool message or a message without tool calls", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [, result, plain] = yield* store.appendMessages(thread.id, [
          { role: "assistant", content: "calls", tool_calls: toolCalls("call-1") },
          { role: "tool", content: "1", tool_call_id: "call-1" },
          { role: "user", content: "plain" },
          { role: "tool", content: "2", tool_call_id: "call-1" },
        ])
        expect(yield* store.deleteMessage(thread.id, result?.id ?? "")).toBe(true)
        expect(yield* store.deleteMessage(thread.id, plain?.id ?? "")).toBe(true)
        const left = yield* store.getMessages(thread.id, { order: "asc" })
        expect(left.messages.map((m) => m.content)).toEqual(["calls", "2"])
      }).pipe(Effect.provide(inMemory)),
    )
  })

  describe("queue", () => {
    it.effect("enqueue and takeQueue keep messages and tool calls in arrival order and empty the queue", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const other = yield* store.createThread({ agentId: "assistant" })
        yield* store.enqueue(thread.id, { kind: "message", message: { role: "user", content: "first" } })
        yield* store.enqueue(other.id, { kind: "message", message: { role: "user", content: "elsewhere" } })
        yield* store.enqueue(thread.id, { kind: "tool", toolName: "lookup", args: { q: "x" } })
        yield* store.enqueue(thread.id, {
          kind: "message",
          message: { role: "assistant", content: "third", silent: true },
        })
        const taken = yield* store.takeQueue(thread.id)
        expect(taken.map(({ seq: _, queuedAt: __, ...entry }) => entry)).toEqual([
          { kind: "message", message: { role: "user", content: "first" } },
          { kind: "tool", toolName: "lookup", args: { q: "x" } },
          { kind: "message", message: { role: "assistant", content: "third", silent: true } },
        ])
        expect(yield* store.takeQueue(thread.id)).toEqual([])
        expect((yield* store.takeQueue(other.id)).length).toBe(1)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("takeQueue inside a failed transaction leaves the entries queued", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* store.enqueue(thread.id, { kind: "tool", toolName: "lookup", args: {} })
        yield* Effect.flip(store.transaction(Effect.andThen(store.takeQueue(thread.id), Effect.fail("crash"))))
        expect((yield* store.takeQueue(thread.id)).length).toBe(1)
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
            new Date(0),
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
        for (const value of [new Money(), inherited, new Date(0), new Map(), rootWithToJson, throwingPrototype]) {
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

  describe("text", () => {
    const nul = (label: string) => `${label}\u0000after`

    it.effect("every text column reads back exactly as written, including a NUL character", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const written = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            const parent = yield* store.createThread({ agentId: "parent" })
            const thread = yield* store.createThread({
              agentId: nul("agent"),
              parentId: parent.id,
              arguments: { [nul("argument key")]: nul("argument") },
            })
            const status = yield* store.setStatus(thread.id, { state: "idle", reason: nul("reason") })
            const [message] = yield* store.appendMessages(thread.id, [
              {
                role: "tool",
                content: nul("content"),
                name: nul("name"),
                tool_calls: nul("tool_calls"),
                tool_call_id: nul("tool_call_id"),
                reasoning_content: nul("reasoning_content"),
                reasoning_details: nul("reasoning_details"),
                prompt: nul("prompt"),
                parent_id: nul("parent_id"),
                attachments: [
                  {
                    id: nul("id"),
                    type: "file",
                    path: nul("path"),
                    name: nul("name"),
                    mimeType: "text/plain",
                    size: 1,
                  },
                ],
                metadata: { [nul("metadata key")]: nul("metadata") },
              },
            ])
            yield* store.enqueue(thread.id, { kind: "message", message: { role: "user", content: nul("queued") } })
            yield* store.enqueue(thread.id, {
              kind: "tool",
              toolName: nul("tool"),
              args: { [nul("arg")]: nul("value") },
            })
            yield* store.setValue(thread.id, nul("key"), { [nul("value key")]: nul("value") })
            return { thread: yield* store.getThread(thread.id), status, message }
          }).pipe(Effect.provide(storeAt(filename)))
          expect(written.thread.agentId).toBe(nul("agent"))
          expect(written.thread.arguments).toEqual({ [nul("argument key")]: nul("argument") })
          expect(written.status.reason).toBe(nul("reason"))
          expect(written.thread.status).toEqual(written.status)

          yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            const threadId = written.thread.id
            expect(yield* store.getThread(threadId)).toEqual(written.thread)
            expect(yield* store.getMessage(threadId, written.message?.id ?? "")).toEqual(written.message)
            expect((yield* store.getMessages(threadId)).messages).toEqual([written.message])
            expect(written.message?.content).toBe(nul("content"))
            expect(yield* store.takeQueue(threadId)).toMatchObject([
              { kind: "message", message: { role: "user", content: nul("queued") } },
              { kind: "tool", toolName: nul("tool"), args: { [nul("arg")]: nul("value") } },
            ])
            expect(yield* store.getValue(threadId, nul("key"))).toEqual({ [nul("value key")]: nul("value") })
            expect(yield* store.getValue(threadId, "key")).toBeNull()
          }).pipe(Effect.provide(storeAt(filename)))
        }),
      ),
    )

    it.effect("updateMessage with only metadata leaves the content as written", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const [message] = yield* store.appendMessages(thread.id, [user(nul("before"))])
        yield* store.updateMessage(thread.id, message?.id ?? "", { metadata: { touched: true } })
        const updated = yield* store.updateMessage(thread.id, message?.id ?? "", { metadata: { again: true } })
        expect(updated).toEqual({ ...message, metadata: { touched: true, again: true } })
        expect(yield* store.getMessage(thread.id, message?.id ?? "")).toEqual(updated)
      }).pipe(Effect.provide(inMemory)),
    )
  })
})
