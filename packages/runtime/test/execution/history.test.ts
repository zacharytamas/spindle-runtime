import { describe, expect, it } from "@effect/vitest"
import { defineHook, defineTool, type Message, type ThreadState } from "@standardagents/spec"
import { Effect, Layer } from "effect"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { ok, project, type Setup } from "../../../conformance/src/scenarios/step-loop.ts"
import { newSecrets } from "../../src/execution/env.ts"
import { copyMessage, makeHistory } from "../../src/execution/history.ts"
import type { HookScope } from "../../src/execution/hooks.ts"
import { createMessage } from "../../src/execution/messages.ts"
import type { ExecutionEvent } from "../../src/execution/step.ts"
import { layer as supervisorLayer } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage } from "../../src/execution/trigger.ts"
import { layer } from "../../src/store/sqlite.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf } from "../spindle-driver.ts"

const contents = (messages: ReadonlyArray<Message>) => messages.map((message) => message.content)

const inMemory = () => Layer.fresh(layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" }))))

// A store that counts the reads of a thread's whole history that it serves.
const countingStore = (reads: { count: number }) =>
  Layer.effect(
    ThreadStore,
    Effect.gen(function* () {
      const store = yield* ThreadStore
      return ThreadStore.of({
        ...store,
        history: (threadId) =>
          Effect.suspend(() => {
            reads.count += 1
            return store.history(threadId)
          }),
      })
    }),
  ).pipe(Layer.provide(inMemory()))

const runOnce = (setup: Setup, reads: { count: number }) =>
  Effect.gen(function* () {
    const thread = yield* createThread("assistant")
    const { outcome } = yield* sendMessage(thread.id, "go")
    if (outcome === undefined) return yield* Effect.die("the run had no outcome")
    return outcome
  }).pipe(
    Effect.provide(
      Layer.merge(registryOf(project(setup)), Layer.provideMerge(supervisorLayer(), countingStore(reads))),
    ),
  )

const keepHandle = (keep: (state: ThreadState) => void) =>
  defineHook({
    hook: "after_thread_created",
    id: "keep_handle",
    execute: async (state) => {
      keep(state)
    },
  })

describe("the history an execution keeps", () => {
  it.effect("is read whole once over twenty steps that nobody else writes to, and once more after a write", () =>
    Effect.gen(function* () {
      const reads = { count: 0 }
      let elsewhere: ThreadState | undefined
      const perStep: Array<number> = []
      let last: Array<unknown> = []
      const hooks = [
        keepHandle((state) => {
          elsewhere = state
        }),
        defineHook({
          hook: "after_system_message",
          id: "write_last",
          execute: async (state) => {
            if (state.execution?.stepCount === 20)
              await elsewhere?.injectMessage({ role: "user", content: "from another handle" })
            return null
          },
        }),
        defineHook({
          hook: "filter_messages",
          id: "count",
          execute: async (_state, messages) => {
            perStep.push(reads.count)
            last = contents(messages)
            return messages
          },
        }),
      ]
      const provider = new ScriptedProvider([
        ...Array.from({ length: 20 }, (_, index) => ({
          toolCalls: [{ id: `c${index}`, name: "noop", arguments: {} }],
        })),
        { text: "done" },
      ])
      const tools = { noop: defineTool({ description: "Does nothing", execute: async () => ok("noop") }) }
      const outcome = yield* runOnce(
        { provider, tools, hooks, agent: { hooks: ["keep_handle"] }, prompt: { hooks: ["write_last", "count"] } },
        reads,
      )
      expect(outcome.steps).toBe(21)
      expect(perStep).toEqual([...Array.from({ length: 20 }, () => 1), 2])
      expect(last.at(-1)).toBe("from another handle")
      expect(last).toHaveLength(42)
    }),
  )

  it.effect("serves repeated reads of execution.messageHistory in one step without a whole read after the first", () =>
    Effect.gen(function* () {
      const reads = { count: 0 }
      let elsewhere: ThreadState | undefined
      const seen: Record<string, unknown> = {}
      const tools = {
        look: defineTool({
          description: "Read the live history many times",
          execute: async (state: ThreadState) => {
            const live = () => state.execution?.messageHistory ?? []
            const mine = live()
            const afterFirst = reads.count
            mine.pop()
            if (mine[0] !== undefined) {
              mine[0].content = "changed by the tool"
              Object.assign(mine[0].metadata ?? {}, { changed: true })
            }
            const again = Array.from({ length: 9 }, live)
            seen.quiet = {
              added: reads.count - afterFirst,
              reads: again.map(contents),
              metadata: again.map((read) => read[0]?.metadata),
            }
            await elsewhere?.injectMessage({ role: "user", content: "from another handle" })
            const afterWrite = live()
            const beforeMore = reads.count
            Array.from({ length: 9 }, live)
            seen.written = {
              contents: contents(afterWrite),
              added: reads.count - afterFirst,
              more: reads.count - beforeMore,
            }
            return ok("looked")
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "look", arguments: {} }] },
        { text: "done" },
      ])
      yield* runOnce(
        {
          provider,
          tools,
          hooks: [
            keepHandle((state) => {
              elsewhere = state
            }),
          ],
          agent: { hooks: ["keep_handle"] },
        },
        reads,
      )
      expect(seen).toEqual({
        quiet: {
          added: 0,
          reads: Array.from({ length: 9 }, () => ["go", null]),
          metadata: Array.from({ length: 9 }, () => ({})),
        },
        written: { contents: ["go", null, "from another handle"], added: 1, more: 0 },
      })
    }),
  )

  it.effect("stays current through the step's own assistant message and every tool result", () =>
    Effect.gen(function* () {
      const reads = { count: 0 }
      let elsewhere: ThreadState | undefined
      const seen: Array<unknown> = []
      const hooks = [
        keepHandle((state) => {
          elsewhere = state
        }),
        defineHook({
          hook: "after_system_message",
          id: "write_later",
          execute: async (state) => {
            if (state.execution?.stepCount === 1)
              await elsewhere?.injectMessage({ role: "user", content: "from another handle" })
            return null
          },
        }),
        defineHook({
          hook: "filter_messages",
          id: "count",
          execute: async (_state, messages) => {
            seen.push(["filter", reads.count, contents(messages)])
            return messages
          },
        }),
      ]
      const tools = {
        look: defineTool({
          description: "Read the live history",
          execute: async (state: ThreadState) => {
            seen.push(["tool", reads.count, contents(state.execution?.messageHistory ?? [])])
            return ok("looked")
          },
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c1", name: "look", arguments: {} },
            { id: "c2", name: "look", arguments: {} },
            { id: "c3", name: "look", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      yield* runOnce(
        { provider, tools, hooks, agent: { hooks: ["keep_handle"] }, prompt: { hooks: ["write_later", "count"] } },
        reads,
      )
      expect(seen).toEqual([
        ["filter", 1, ["go"]],
        ["tool", 1, ["go", null]],
        ["tool", 1, ["go", null, "looked"]],
        ["tool", 1, ["go", null, "looked", "looked"]],
        ["filter", 2, ["go", null, "looked", "looked", "looked", "from another handle"]],
      ])
    }),
  )

  it.effect("never holds an insert of the execution's that a caller's transaction rolled back", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      yield* store.appendMessages(thread.id, [{ role: "user", content: "first" }])
      const history = makeHistory(thread.id)
      expect(contents(yield* history.read)).toEqual(["first"])
      const hooks: HookScope = {
        set: { source: { kind: "agent", agentName: "assistant" }, byPosition: new Map() },
        stateFor: () => {
          throw new Error("no hook is selected")
        },
      }
      const write = { threadId: thread.id, hooks, secrets: newSecrets(), call: undefined, history }
      const own = createMessage(write, { role: "assistant", content: "rolled back" }, "turn")
      expect(yield* Effect.flip(store.transaction(Effect.andThen(own, Effect.fail("crash"))))).toBe("crash")
      yield* store.appendMessages(thread.id, [{ role: "user", content: "from another writer" }])
      expect(contents(yield* history.read)).toEqual(["first", "from another writer"])
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("never keeps a history it read inside a caller's transaction that rolled back", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      for (const savepoint of [false, true]) {
        const thread = yield* store.createThread({ agentId: "assistant" })
        const append = (content: string) => store.appendMessages(thread.id, [{ role: "user", content }])
        const history = makeHistory(thread.id)
        yield* append("first")
        expect(contents(yield* history.read)).toEqual(["first"])
        const inner = store.transaction(
          Effect.gen(function* () {
            yield* append("rolled back")
            expect(contents(yield* history.read)).toEqual(["first", "rolled back"])
            return yield* Effect.fail("crash")
          }),
        )
        expect(yield* savepoint ? store.transaction(Effect.flip(inner)) : Effect.flip(inner)).toBe("crash")
        yield* append("committed")
        expect(contents(yield* history.read)).toEqual(["first", "committed"])
      }
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("reads the snapshot as the last thing before the first filter_messages hook runs", () =>
    Effect.gen(function* () {
      let elsewhere: ThreadState | undefined
      let wrote = false
      const seen: Array<unknown> = []
      const hooks = [
        keepHandle((state) => {
          elsewhere = state
        }),
        defineHook({
          hook: "filter_messages",
          id: "compare",
          execute: async (state, messages) => {
            seen.push([contents(messages), contents(state.execution?.messageHistory ?? [])])
            return messages
          },
        }),
      ]
      const observe = (event: ExecutionEvent) => {
        if (wrote || event.type !== "trace" || !event.entry.detail.startsWith("snapshot")) return Effect.void
        wrote = true
        return Effect.promise(async () => {
          await elsewhere?.injectMessage({ role: "user", content: "gap" })
        })
      }
      const provider = new ScriptedProvider([{ text: "done" }])
      const setup = { provider, hooks, agent: { hooks: ["keep_handle"] }, prompt: { hooks: ["compare"] } }
      const stored = yield* Effect.gen(function* () {
        const thread = yield* createThread("assistant")
        yield* sendMessage(thread.id, "go", { observe })
        return (yield* (yield* ThreadStore).history(thread.id)).messages
      }).pipe(
        Effect.provide(Layer.merge(registryOf(project(setup)), Layer.provideMerge(supervisorLayer(), inMemory()))),
      )
      expect(seen).toEqual([[["go"], ["go"]]])
      expect(contents(stored)).toEqual(["go", "gap", "done"])
    }),
  )

  it("copies a message deeply, and keeps a __proto__ key of its metadata as an own key", () => {
    const metadata = JSON.parse('{"__proto__": {"inherited": true}, "list": [{"deep": 1}]}')
    const attachments = [{ type: "file", id: "f", path: "/f", name: "f", mimeType: "text/plain", size: 1 }]
    const message = { id: "m", role: "user", content: "x", created_at: 1, metadata, attachments } as Message
    const copy = copyMessage(message)
    expect(Object.keys(copy.metadata ?? {})).toEqual(["__proto__", "list"])
    expect(JSON.stringify(copy)).toBe(JSON.stringify(message))
    expect([copy.metadata, copy.metadata?.list, copy.attachments, copy.attachments?.[0]]).not.toContain(metadata)
    expect(copy.metadata?.list).not.toBe(metadata.list)
    expect(copy.attachments?.[0]).not.toBe(attachments[0])
  })
})
