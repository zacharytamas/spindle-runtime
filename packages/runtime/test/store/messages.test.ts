import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { admitEntry, appendMessages, drainEntries, settleRun } from "../../scripts/store-fixtures.ts"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { external } from "../../src/store/model.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"

import { claim, inMemory, storeAt, toolCalls, user, withDatabaseFile } from "./contract-fixtures.ts"

describe("ThreadStore", () => {
  describe("messages", () => {
    it.effect("appendMessages returns the stored records and getMessage reads each one back", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [assistant] = yield* appendMessages(thread.id, [
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
        expect(yield* messageStore.getMessage(thread.id, assistant?.id ?? "")).toEqual({
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
        expect(yield* messageStore.getMessage(thread.id, "missing")).toBeNull()
        const [plain] = yield* appendMessages(thread.id, [user("no reasoning here")])
        expect(yield* messageStore.getMessage(thread.id, plain?.id ?? "")).toMatchObject({
          reasoning_content: null,
          reasoning_details: null,
        })
        expect((yield* messageStore.getMessages(thread.id, { order: "asc" })).messages).toEqual([
          yield* messageStore.getMessage(thread.id, assistant?.id ?? ""),
          plain,
        ])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages gives each message a unique id and its creation time in microseconds", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        yield* TestClock.adjust("1500 millis")
        const first = yield* appendMessages(thread.id, [user("a"), user("b")])
        yield* TestClock.adjust("1 second")
        const second = yield* appendMessages(thread.id, [user("c")])
        const read = (yield* messageStore.getMessages(thread.id, { order: "asc" })).messages
        expect(read.map((m) => m.created_at)).toEqual([1_500_000, 1_500_000, 2_500_000])
        expect(new Set(read.map((m) => m.id)).size).toBe(3)
        expect(read.map((m) => m.id)).toEqual([...first, ...second].map((m) => m.id))
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("insertMessage keeps the id and creation time the caller chose and stores it in arrival order", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        yield* TestClock.adjust("5 seconds")
        const [first] = yield* appendMessages(thread.id, [user("first")])
        const { message: inserted } = yield* messageStore.insertMessage(
          thread.id,
          {
            id: "chosen-id",
            created_at: 42,
            role: "user",
            content: "second",
            silent: true,
            metadata: { stamped: true },
          },
          external,
        )
        expect(inserted).toMatchObject({ id: "chosen-id", created_at: 42, content: "second", silent: true })
        expect(yield* messageStore.getMessage(thread.id, "chosen-id")).toEqual(inserted)
        const read = (yield* messageStore.getMessages(thread.id, { order: "asc", includeSilent: true })).messages
        expect(read.map((m) => [m.id, m.created_at])).toEqual([
          [first?.id, 5_000_000],
          ["chosen-id", 42],
        ])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("insertMessage fails with MessageIdTaken for an id that any thread holds and keeps the first row", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const other = yield* threadStore.createThread({ agentId: "assistant" })
        const [existing] = yield* appendMessages(thread.id, [user("original")])
        const id = existing?.id ?? ""
        const again = yield* Effect.flip(
          messageStore.insertMessage(thread.id, { id, created_at: 1, role: "user", content: "replacement" }, external),
        )
        expect(again).toMatchObject({ _tag: "MessageIdTaken", messageId: id })
        const elsewhere = yield* Effect.flip(
          messageStore.insertMessage(other.id, { id, created_at: 1, role: "user", content: "elsewhere" }, external),
        )
        expect(elsewhere._tag).toBe("MessageIdTaken")
        expect(yield* messageStore.getMessage(thread.id, id)).toEqual(existing)
        expect((yield* messageStore.getMessages(thread.id, { includeSilent: true })).total).toBe(1)
        expect((yield* messageStore.getMessages(other.id, { includeSilent: true })).total).toBe(0)
        const missing = yield* Effect.flip(
          messageStore.insertMessage("missing", { id: "fresh", created_at: 1, role: "user", content: "x" }, external),
        )
        expect(missing._tag).toBe("ThreadNotFound")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("messageIdTaken says whether any thread holds a message id", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [existing] = yield* appendMessages(thread.id, [user("original")])
        expect(yield* messageStore.messageIdTaken(existing?.id ?? "")).toBe(true)
        expect(yield* messageStore.messageIdTaken("fresh")).toBe(false)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages keeps reasoning_content and reasoning_details independently of each other", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const written = yield* appendMessages(thread.id, [
          { role: "assistant", content: "a", reasoning_content: "text only" },
          { role: "assistant", content: "b", reasoning_details: '[{"type":"encrypted"}]' },
          { role: "assistant", content: "c" },
        ])
        const read = (yield* messageStore.getMessages(thread.id, { order: "asc" })).messages
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
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        yield* appendMessages(thread.id, [
          user("queued", { status: "pending" }),
          user("done", { status: "completed" }),
          user("broken", { status: "failed" }),
          user("plain"),
        ])
        const read = (yield* messageStore.getMessages(thread.id, { order: "asc" })).messages
        expect(read.map((m) => m.status)).toEqual(["pending", "completed", "failed", null])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("a silent message persists across a restart like a visible one", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const written = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            const thread = yield* store.createThread({ agentId: "assistant" })
            const messages = yield* appendMessages(thread.id, [user("visible"), user("silent", { silent: true })])
            return { threadId: thread.id, messages }
          }).pipe(Effect.provide(storeAt(filename)))
          const read = yield* Effect.gen(function* () {
            const store = yield* MessageStore
            return yield* store.getMessages(written.threadId, { includeSilent: true, order: "asc" })
          }).pipe(Effect.provide(storeAt(filename)))
          expect(read.messages).toEqual(written.messages)
          expect(read.messages.map((m) => m.silent)).toEqual([false, true])
        }),
      ),
    )

    it.effect("appendMessages stores tool results with their name, call id, and status", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const results = yield* appendMessages(thread.id, [
          { role: "tool", content: "42", name: "lookup", tool_call_id: "call-1", tool_status: "success" },
          { role: "tool", content: "timeout", name: "search", tool_call_id: "call-2", tool_status: "error", depth: 1 },
        ])
        const read = yield* messageStore.getMessages(thread.id, { order: "asc" })
        expect(read.messages).toEqual(results)
        expect(read.messages.map((m) => [m.name, m.tool_call_id, m.tool_status, m.depth])).toEqual([
          ["lookup", "call-1", "success", 0],
          ["search", "call-2", "error", 1],
        ])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages writes all records or none when the transaction fails", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const step = threadStore.transaction(
          Effect.gen(function* () {
            yield* appendMessages(thread.id, [{ role: "assistant", content: null, tool_calls: toolCalls("a", "b") }])
            yield* appendMessages(thread.id, [{ role: "tool", content: "ok", tool_call_id: "a" }])
            return yield* Effect.fail("tool b crashed" as const)
          }),
        )
        expect(yield* Effect.flip(step)).toBe("tool b crashed")
        expect((yield* messageStore.getMessages(thread.id)).total).toBe(0)
        yield* appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: toolCalls("a") },
          { role: "tool", content: "ok", tool_call_id: "a" },
        ])
        expect((yield* messageStore.getMessages(thread.id)).total).toBe(2)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "appendMessages and updateMessage fail with ValueNotJson for a BigInt in metadata and write nothing",
      () =>
        Effect.gen(function* () {
          const threadStore = yield* ThreadStore
          const messageStore = yield* MessageStore
          const thread = yield* threadStore.createThread({ agentId: "assistant" })
          const appended = yield* Effect.flip(
            appendMessages(thread.id, [user("first"), user("second", { metadata: { count: 10n } })]),
          )
          expect(appended).toMatchObject({ _tag: "ValueNotJson", path: "$.count", found: "a BigInt" })
          expect(appended.message).toContain("metadata")
          expect((yield* messageStore.getMessages(thread.id)).total).toBe(0)
          const [message] = yield* appendMessages(thread.id, [user("kept", { metadata: { n: 1 } })])
          const updated = yield* Effect.flip(
            messageStore.updateMessage(thread.id, message?.id ?? "", { metadata: { n: 2n } }, external),
          )
          expect(updated).toMatchObject({ _tag: "ValueNotJson", path: "$.n" })
          expect(yield* messageStore.getMessage(thread.id, message?.id ?? "")).toEqual(message)
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages fails with ThreadNotFound and writes nothing for an unknown thread", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(appendMessages("missing", [user("hello")]))
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
              yield* appendMessages(a.id, [user(`a${n}`)])
              yield* appendMessages(b.id, [user(`b${n}`)])
            }
            return [a.id, b.id] as const
          }).pipe(Effect.provide(storeAt(filename)))
          const contents = yield* Effect.gen(function* () {
            const store = yield* MessageStore
            return yield* Effect.forEach(
              ids,
              (id) => Effect.map(store.getMessages(id, { order: "asc" }), (r) => r.messages.map((m) => m.content)),
              { concurrency: 1 },
            )
          }).pipe(Effect.provide(storeAt(filename)))
          expect(contents).toEqual([
            ["a1", "a2", "a3"],
            ["b1", "b2", "b3"],
          ])
        }),
      ),
    )

    it.effect("updateMessage replaces the content and merges the metadata", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [message] = yield* appendMessages(thread.id, [user("draft", { metadata: { source: "tool" } })])
        const updated = yield* messageStore.updateMessage(
          thread.id,
          message?.id ?? "",
          {
            content: "final",
            metadata: { edited: true },
          },
          external,
        )
        expect(updated).toEqual({ ...message, content: "final", metadata: { source: "tool", edited: true } })
        expect(yield* messageStore.getMessage(thread.id, message?.id ?? "")).toEqual(updated)
        const error = yield* Effect.flip(messageStore.updateMessage(thread.id, "missing", { content: "x" }, external))
        expect(error._tag).toBe("MessageNotFound")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "deleteMessage returns whether it removed a message and removes the tool results of an assistant message",
      () =>
        Effect.gen(function* () {
          const threadStore = yield* ThreadStore
          const messageStore = yield* MessageStore
          const thread = yield* threadStore.createThread({ agentId: "assistant" })
          const [, assistant] = yield* appendMessages(thread.id, [
            user("look up two things"),
            { role: "assistant", content: null, tool_calls: toolCalls("call-1", "call-2") },
            { role: "tool", content: "1", tool_call_id: "call-1" },
            { role: "tool", content: "2", tool_call_id: "call-2" },
            { role: "tool", content: "other", tool_call_id: "call-3" },
          ])
          expect(yield* messageStore.deleteMessage(thread.id, assistant?.id ?? "", external)).toBe(true)
          expect(yield* messageStore.deleteMessage(thread.id, assistant?.id ?? "", external)).toBe(false)
          const left = yield* messageStore.getMessages(thread.id, { order: "asc" })
          expect(left.messages.map((m) => m.content)).toEqual(["look up two things", "other"])
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage keeps the results of a later assistant message that reuses a tool call id", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [first, , second] = yield* appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: toolCalls("call_0") },
          { role: "tool", content: "first result", tool_call_id: "call_0" },
          { role: "assistant", content: null, tool_calls: toolCalls("call_0") },
          { role: "tool", content: "second result", tool_call_id: "call_0" },
        ])
        expect(yield* messageStore.deleteMessage(thread.id, first?.id ?? "", external)).toBe(true)
        const left = yield* messageStore.getMessages(thread.id, { order: "asc" })
        expect(left.messages.map((m) => [m.id === second?.id, m.content])).toEqual([
          [true, null],
          [false, "second result"],
        ])
        expect(yield* messageStore.deleteMessage(thread.id, second?.id ?? "", external)).toBe(true)
        expect((yield* messageStore.getMessages(thread.id)).total).toBe(0)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage keeps the result of an assistant message under another parent that reuses the id", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [outer, inner] = yield* appendMessages(thread.id, [user("outer"), user("inner")])
        const under = (parent: typeof outer) => ({ parent_id: parent?.id ?? null })
        const [, second] = yield* appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: toolCalls("shared"), ...under(outer) },
          { role: "assistant", content: null, tool_calls: toolCalls("shared"), ...under(inner) },
          { role: "tool", content: "outer result", tool_call_id: "shared", ...under(outer) },
          { role: "tool", content: "inner result", tool_call_id: "shared", ...under(inner) },
        ])
        expect(yield* messageStore.deleteMessage(thread.id, second?.id ?? "", external)).toBe(true)
        const left = yield* messageStore.getMessages(thread.id, { order: "asc" })
        expect(left.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["outer result"])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("a leading U+FEFF survives next to a NUL character", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [written] = yield* appendMessages(thread.id, [user("\uFEFFa\u0000b")])
        expect((yield* messageStore.getMessage(thread.id, written?.id ?? ""))?.content).toBe("\uFEFFa\u0000b")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("a write returns the record a later read returns when the text holds a lone surrogate", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [written] = yield* appendMessages(thread.id, [
          { role: "tool", content: "a\ud800b", name: "n\udc00", tool_call_id: "i\ud800" },
        ])
        expect(written?.content).toBe("a\ufffdb")
        expect(yield* messageStore.getMessage(thread.id, written?.id ?? "")).toEqual(written)
        const updated = yield* messageStore.updateMessage(thread.id, written?.id ?? "", { content: "\ud800" }, external)
        expect(updated.content).toBe("\ufffd")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("appendMessages returns the parent id a fresh connection reads for a lone surrogate", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const writer = yield* ThreadStore
          const thread = yield* writer.createThread({ agentId: "assistant" })
          const [written] = yield* appendMessages(thread.id, [user("child", { parent_id: "p\ud800" })])
          const read = yield* MessageStore.use((reader) => reader.getMessage(thread.id, written?.id ?? "")).pipe(
            Effect.provide(storeAt(filename)),
          )
          expect(read?.parent_id).toBe("p\ufffd")
          expect(written?.parent_id).toBe(read?.parent_id)
        }).pipe(Effect.provide(storeAt(filename))),
      ),
    )

    it.effect("deleteMessage removes an assistant message whose tool_calls is not JSON", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [broken] = yield* appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: "not json" },
          { role: "tool", content: "kept", tool_call_id: "call_0" },
        ])
        expect(yield* messageStore.deleteMessage(thread.id, broken?.id ?? "", external)).toBe(true)
        expect((yield* messageStore.getMessages(thread.id)).messages.map((m) => m.content)).toEqual(["kept"])
        const [valid] = yield* appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: toolCalls("call_1") },
          { role: "assistant", content: null, tool_calls: "not json" },
          { role: "tool", content: "removed", tool_call_id: "call_1" },
        ])
        expect(yield* messageStore.deleteMessage(thread.id, valid?.id ?? "", external)).toBe(true)
        const contents = (yield* messageStore.getMessages(thread.id)).messages.map((m) => m.content)
        expect(contents).not.toContain("removed")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "deleteMessage removes an assistant message whose tool_calls array holds an entry that is not an object",
      () =>
        Effect.gen(function* () {
          const threadStore = yield* ThreadStore
          const messageStore = yield* MessageStore
          const thread = yield* threadStore.createThread({ agentId: "assistant" })
          const calls = JSON.stringify(["not an envelope", ...JSON.parse(toolCalls("call_1"))])
          const [assistant] = yield* appendMessages(thread.id, [
            { role: "assistant", content: null, tool_calls: calls },
            { role: "tool", content: "removed", tool_call_id: "call_1" },
            { role: "tool", content: "kept", tool_call_id: "not an envelope" },
          ])
          expect(yield* messageStore.deleteMessage(thread.id, assistant?.id ?? "", external)).toBe(true)
          expect((yield* messageStore.getMessages(thread.id)).messages.map((m) => m.content)).toEqual(["kept"])
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "deleteMessage removes the results of an assistant message when a later one holds a non-object entry",
      () =>
        Effect.gen(function* () {
          const threadStore = yield* ThreadStore
          const messageStore = yield* MessageStore
          const thread = yield* threadStore.createThread({ agentId: "assistant" })
          const [assistant] = yield* appendMessages(thread.id, [
            { role: "assistant", content: null, tool_calls: toolCalls("call_1") },
            { role: "assistant", content: null, tool_calls: JSON.stringify(["not an envelope"]) },
            { role: "tool", content: "removed", tool_call_id: "call_1" },
          ])
          expect(yield* messageStore.deleteMessage(thread.id, assistant?.id ?? "", external)).toBe(true)
          const left = yield* messageStore.getMessages(thread.id, { order: "asc" })
          expect(left.messages.map((m) => [m.role, m.content])).toEqual([["assistant", null]])
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage removes only the results under its own parent when a parent id holds a NUL", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const survivorAfterDeleting = (parent: "p" | "p\u0000suffix") =>
          Effect.gen(function* () {
            const thread = yield* threadStore.createThread({ agentId: "assistant" })
            const [short, long] = yield* appendMessages(thread.id, [
              { role: "assistant", content: null, tool_calls: toolCalls("shared"), parent_id: "p" },
              { role: "assistant", content: null, tool_calls: toolCalls("shared"), parent_id: "p\u0000suffix" },
              { role: "tool", content: "short result", tool_call_id: "shared", parent_id: "p" },
              { role: "tool", content: "long result", tool_call_id: "shared", parent_id: "p\u0000suffix" },
            ])
            const deleted = parent === "p" ? short : long
            expect(yield* messageStore.deleteMessage(thread.id, deleted?.id ?? "", external)).toBe(true)
            const left = yield* messageStore.getMessages(thread.id, { order: "asc" })
            return left.messages.filter((m) => m.role === "tool").map((m) => m.content)
          })
        expect(yield* survivorAfterDeleting("p\u0000suffix")).toEqual(["short result"])
        expect(yield* survivorAfterDeleting("p")).toEqual(["long result"])
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("updateMessage fails with ValueNotJson when a metadata getter throws", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [written] = yield* appendMessages(thread.id, [user("hello")])
        const metadata = {
          get broken(): never {
            throw new Error("getter")
          },
        }
        const error = yield* Effect.flip(
          messageStore.updateMessage(thread.id, written?.id ?? "", { metadata }, external),
        )
        expect(error._tag).toBe("ValueNotJson")
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage removes the tool results of a user message that lists their call ids", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [first, , second] = yield* appendMessages(thread.id, [
          { role: "user", content: "side B call", tool_calls: toolCalls("call-1") },
          { role: "tool", content: "first result", tool_call_id: "call-1" },
          { role: "user", content: "side B again", tool_calls: toolCalls("call-1") },
          { role: "tool", content: "second result", tool_call_id: "call-1" },
        ])
        expect(yield* messageStore.deleteMessage(thread.id, first?.id ?? "", external)).toBe(true)
        const left = yield* messageStore.getMessages(thread.id, { order: "asc" })
        expect(left.messages.map((m) => m.content)).toEqual(["side B again", "second result"])
        expect(yield* messageStore.deleteMessage(thread.id, second?.id ?? "", external)).toBe(true)
        expect((yield* messageStore.getMessages(thread.id)).total).toBe(0)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("deleteMessage removes only the record itself for a tool message or a message without tool calls", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [, result, plain] = yield* appendMessages(thread.id, [
          { role: "assistant", content: "calls", tool_calls: toolCalls("call-1") },
          { role: "tool", content: "1", tool_call_id: "call-1" },
          { role: "user", content: "plain" },
          { role: "tool", content: "2", tool_call_id: "call-1" },
        ])
        expect(yield* messageStore.deleteMessage(thread.id, result?.id ?? "", external)).toBe(true)
        expect(yield* messageStore.deleteMessage(thread.id, plain?.id ?? "", external)).toBe(true)
        const left = yield* messageStore.getMessages(thread.id, { order: "asc" })
        expect(left.messages.map((m) => m.content)).toEqual(["calls", "2"])
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
            const [message] = yield* appendMessages(thread.id, [
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
            yield* admitEntry(thread.id, { kind: "message", message: { role: "user", content: nul("queued") } }, claim)
            yield* admitEntry(
              thread.id,
              {
                kind: "tool",
                toolName: nul("tool"),
                args: { [nul("arg")]: nul("value") },
              },
              claim,
            )
            const status = yield* settleRun(thread.id, claim, { state: "idle", reason: nul("reason") })
            yield* store.setValue(thread.id, nul("key"), { [nul("value key")]: nul("value") }, external)
            return { thread: yield* store.getThread(thread.id), status, message }
          }).pipe(Effect.provide(storeAt(filename)))
          expect(written.thread.agentId).toBe(nul("agent"))
          expect(written.thread.arguments).toEqual({ [nul("argument key")]: nul("argument") })
          expect(written.status.reason).toBe(nul("reason"))
          expect(written.thread.status).toEqual(written.status)

          yield* Effect.gen(function* () {
            const threadStore = yield* ThreadStore
            const messageStore = yield* MessageStore
            const runStore = yield* RunStore
            const threadId = written.thread.id
            expect(yield* threadStore.getThread(threadId)).toEqual(written.thread)
            expect(yield* messageStore.getMessage(threadId, written.message?.id ?? "")).toEqual(written.message)
            expect((yield* messageStore.getMessages(threadId)).messages).toEqual([written.message])
            expect(written.message?.content).toBe(nul("content"))
            yield* runStore.claim(threadId, claim)
            expect(yield* drainEntries(threadId, claim.flowId)).toMatchObject([
              { kind: "message", message: { role: "user", content: nul("queued") } },
              { kind: "tool", toolName: nul("tool"), args: { [nul("arg")]: nul("value") } },
            ])
            expect(yield* threadStore.getValue(threadId, nul("key"))).toEqual({ [nul("value key")]: nul("value") })
            expect(yield* threadStore.getValue(threadId, "key")).toBeNull()
          }).pipe(Effect.provide(storeAt(filename)))
        }),
      ),
    )

    it.effect("updateMessage with only metadata leaves the content as written", () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const messageStore = yield* MessageStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        const [message] = yield* appendMessages(thread.id, [user(nul("before"))])
        yield* messageStore.updateMessage(thread.id, message?.id ?? "", { metadata: { touched: true } }, external)
        const updated = yield* messageStore.updateMessage(
          thread.id,
          message?.id ?? "",
          { metadata: { again: true } },
          external,
        )
        expect(updated).toEqual({ ...message, metadata: { touched: true, again: true } })
        expect(yield* messageStore.getMessage(thread.id, message?.id ?? "")).toEqual(updated)
      }).pipe(Effect.provide(inMemory)),
    )
  })
})
