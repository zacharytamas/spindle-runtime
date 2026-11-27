import { describe, expect, it } from "@effect/vitest"
import { defineHook, defineTool, type Message, type ThreadState } from "@standardagents/spec"
import { Effect, Fiber, Layer } from "effect"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { ok, project, type Setup } from "../../../conformance/src/scenarios/harness.ts"
import { appendMessages } from "../../scripts/store-fixtures.ts"
import { newSecrets } from "../../src/execution/env.ts"
import { copyMessage, makeHistory } from "../../src/execution/history.ts"
import type { HookScope } from "../../src/execution/hooks.ts"
import { commitMessage } from "../../src/execution/messages.ts"
import type { ExecutionEvent } from "../../src/execution/step.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage, stateAtRest } from "../../src/execution/trigger.ts"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { external } from "../../src/store/model.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { layer } from "../../src/store/sqlite.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf } from "../spindle-driver.ts"

const contents = (messages: ReadonlyArray<Message>) => messages.map((message) => message.content)

const inMemory = () => Layer.fresh(layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" }))))

// A store that counts the reads of a thread's whole history that it serves.
const countingStore = (reads: { count: number }) =>
  Layer.effect(
    MessageStore,
    Effect.gen(function* () {
      const store = yield* MessageStore
      return MessageStore.of({
        ...store,
        history: (threadId) =>
          Effect.suspend(() => {
            reads.count += 1
            return store.history(threadId)
          }),
      })
    }),
  ).pipe(Layer.provideMerge(inMemory()))

const runOnce = (setup: Setup, reads: { count: number }, outside?: (state: ThreadState) => void) =>
  Effect.gen(function* () {
    const thread = yield* createThread("assistant")
    if (outside) outside(yield* stateAtRest(thread.id))
    const { outcome } = yield* sendMessage(thread.id, "go")
    if (outcome === undefined) return yield* Effect.die("the run had no outcome")
    return outcome
  }).pipe(
    Effect.provide(
      Layer.merge(registryOf(project(setup)), Layer.provideMerge(supervisorLayer(), countingStore(reads))),
    ),
  )

describe("the history an execution keeps", () => {
  it.effect("is read whole once over twenty steps that nobody else writes to, and once more after a write", () =>
    Effect.gen(function* () {
      const reads = { count: 0 }
      let elsewhere: ThreadState | undefined
      const perStep: Array<number> = []
      let last: Array<unknown> = []
      const hooks = [
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
        { provider, tools, hooks, prompt: { hooks: ["write_last", "count"] } },
        reads,
        (state) => {
          elsewhere = state
        },
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
        },
        reads,
        (state) => {
          elsewhere = state
        },
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
      yield* runOnce({ provider, tools, hooks, prompt: { hooks: ["write_later", "count"] } }, reads, (state) => {
        elsewhere = state
      })
      expect(seen).toEqual([
        ["filter", 1, ["go"]],
        ["tool", 1, ["go", null]],
        ["tool", 1, ["go", null, "looked"]],
        ["tool", 1, ["go", null, "looked", "looked"]],
        ["filter", 2, ["go", null, "looked", "looked", "looked", "from another handle"]],
      ])
    }),
  )

  it.effect("keeps each own insert and its caller sequence in the new snapshot only", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadStore
      const messages = yield* MessageStore
      const thread = yield* threads.createThread({ agentId: "assistant" })
      const runs = yield* RunStore
      yield* runs.admit(
        thread.id,
        { kind: "message", message: { role: "user", content: "go" } },
        { flowId: "f", holder: "h" },
        external,
      )
      const history = makeHistory(thread.id)
      const empty = yield* history.read
      const caller = yield* messages.insertMessage(
        thread.id,
        { role: "assistant", id: "call", created_at: 1 },
        { kind: "flow", flowId: "f" },
      )
      history.inserted(caller)
      const first = yield* history.read
      const result = yield* messages.insertMessage(
        thread.id,
        { role: "tool", id: "result", created_at: 2 },
        { kind: "flow", flowId: "f" },
        { callerSeq: caller.seq },
      )
      history.inserted(result)
      expect(empty.rows).toHaveLength(0)
      expect(first.rows).toHaveLength(1)
      expect((yield* history.read).rows.map(({ seq, callerSeq }) => [seq, callerSeq])).toEqual([
        [caller.seq, null],
        [result.seq, caller.seq],
      ])
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("never holds an insert of the execution's that a caller's transaction rolled back", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      yield* appendMessages(thread.id, [{ role: "user", content: "first" }])
      const history = makeHistory(thread.id)
      expect(contents((yield* history.read).rows.map((row) => row.message))).toEqual(["first"])
      const hooks: HookScope = {
        set: { source: { kind: "agent", agentName: "assistant" }, byPosition: new Map() },
        stateFor: () => {
          throw new Error("no hook is selected")
        },
      }
      const write = { origin: external, threadId: thread.id, hooks, secrets: newSecrets(), call: undefined, history }
      const own = commitMessage(write, { role: "assistant", content: "rolled back" })
      expect(yield* Effect.flip(store.transaction(Effect.andThen(own, Effect.fail("crash"))))).toBe("crash")
      yield* appendMessages(thread.id, [{ role: "user", content: "from another writer" }])
      expect(contents((yield* history.read).rows.map((row) => row.message))).toEqual(["first", "from another writer"])
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("never keeps a history it read inside a caller's transaction that rolled back", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      for (const savepoint of [false, true]) {
        const thread = yield* store.createThread({ agentId: "assistant" })
        const append = (content: string) => appendMessages(thread.id, [{ role: "user", content }])
        const history = makeHistory(thread.id)
        yield* append("first")
        expect(contents((yield* history.read).rows.map((row) => row.message))).toEqual(["first"])
        const inner = store.transaction(
          Effect.gen(function* () {
            yield* append("rolled back")
            expect(contents((yield* history.read).rows.map((row) => row.message))).toEqual(["first", "rolled back"])
            return yield* Effect.fail("crash")
          }),
        )
        expect(yield* savepoint ? store.transaction(Effect.flip(inner)) : Effect.flip(inner)).toBe("crash")
        yield* append("committed")
        expect(contents((yield* history.read).rows.map((row) => row.message))).toEqual(["first", "committed"])
      }
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("reads the snapshot as the last thing before the first filter_messages hook runs", () =>
    Effect.gen(function* () {
      let elsewhere: ThreadState | undefined
      let wrote = false
      const seen: Array<unknown> = []
      const hooks = [
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
      const setup = { provider, hooks, prompt: { hooks: ["compare"] } }
      const stored = yield* Effect.gen(function* () {
        const thread = yield* createThread("assistant")
        elsewhere = yield* stateAtRest(thread.id)
        yield* sendMessage(thread.id, "go", { observe })
        return (yield* (yield* MessageStore).history(thread.id)).rows.map((row) => row.message)
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

it.effect("runs the committed claim when its sender is interrupted before executor installation", () => {
  const provider = new ScriptedProvider([{ text: "first" }, { text: "second" }])
  let cut = true
  const store = Layer.effect(
    RunStore,
    Effect.gen(function* () {
      const original = yield* RunStore
      return RunStore.of({
        ...original,
        admit: (...args) =>
          original.admit(...args).pipe(
            Effect.tap(() =>
              Effect.withFiberSucceed((fiber) => {
                if (cut) {
                  cut = false
                  fiber.interruptUnsafe()
                }
              }),
            ),
          ),
      })
    }),
  ).pipe(Layer.provideMerge(inMemory()))
  return Effect.gen(function* () {
    const thread = yield* createThread("assistant")
    const sender = yield* Effect.forkChild(sendMessage(thread.id, "one"))
    yield* Fiber.await(sender)
    const supervisor = yield* ThreadSupervisor
    yield* supervisor.settled(thread.id)
    expect((yield* supervisor.status(thread.id)).state).toBe("idle")
    expect((yield* sendMessage(thread.id, "two")).outcome?.status).toBe("idle")
    expect(provider.requests).toHaveLength(2)
  }).pipe(Effect.provide(Layer.merge(registryOf(project({ provider })), Layer.provideMerge(supervisorLayer(), store))))
})
