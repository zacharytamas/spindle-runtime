import { describe, expect, it } from "@effect/vitest"
import { defineHook, defineTool, type Message, type ThreadState } from "@standardagents/spec"
import { Effect, Fiber, Layer } from "effect"
import * as Statement from "effect/sql/Statement"
import { expectTypeOf } from "vitest"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import {
  history as historyOf,
  ok,
  project,
  type Setup,
  sideOf,
  stubTool,
  using,
} from "../../../conformance/src/scenarios/harness.ts"
import { dualProject, forceTool, usingDual } from "../../../conformance/src/scenarios/sides/fixtures.ts"
import { appendMessages } from "../../scripts/store-fixtures.ts"
import type { HistoryView } from "../../src/execution/assemble.ts"
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
import { registryOf, spindleDriver } from "../spindle-driver.ts"

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

describe("turnStartSeq boundary and performance guard (rule 3, §5)", () => {
  const currentOnly = { includeChat: false, includePastTools: false }

  it("rule 61: starts a same-side forceTurn with fresh chat and tool history", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "work", name: "work", arguments: {} }] },
      { toolCalls: [{ id: "force", name: "again", arguments: {} }] },
      { text: "fresh" },
    ])
    await using(
      spindleDriver,
      {
        provider,
        prompt: currentOnly,
        tools: { work: stubTool("Work", "done"), again: forceTool("a") },
      },
      async (session, thread) => {
        expect(await session.send(thread, "first turn")).toMatchObject({ reason: "stop_on_response", steps: 3 })
      },
    )
    expect(historyOf(provider.requests[2]).map(sideOf)).toEqual([])
  })

  it("rule 61: hands off the first peer-visible response even when the final response only calls a tool", async () => {
    const providerA = new ScriptedProvider([
      { text: "draft", toolCalls: [{ id: "save", name: "save", arguments: {} }] },
      { toolCalls: [{ id: "submit", name: "submit", arguments: {} }] },
    ])
    const providerB = new ScriptedProvider([{ text: "reviewed" }])
    await usingDual(
      spindleDriver,
      {
        providerA,
        providerB,
        promptA: currentOnly,
        promptB: currentOnly,
        tools: { save: stubTool("Save", "saved"), submit: stubTool("Submit", "submitted") },
        sideA: { stopTool: "submit" },
        agent: { maxSessionTurns: 2 },
      },
      async (session, thread) => {
        expect(await session.send(thread, "write")).toMatchObject({ reason: "max_session_turns", steps: 3 })
      },
    )
    expect(historyOf(providerB.requests[0]).map(sideOf)).toEqual([
      ["assistant", "write", []],
      ["user", "draft"],
    ])
  })

  it("rule 61: keeps the triggering delivery and the note its delivery hook injects", async () => {
    const provider = new ScriptedProvider([{ text: "answer" }])
    const hook = defineHook({
      hook: "after_create_message",
      id: "annotate",
      execute: async (state, message) => {
        if (message.content === "question") await state.injectMessage({ role: "user", content: "note" })
      },
    })
    await using(
      spindleDriver,
      { provider, prompt: currentOnly, hooks: [hook], agent: { hooks: [hook.id] } },
      (session, thread) => session.send(thread, "question"),
    )
    expect(historyOf(provider.requests[0]).map(sideOf)).toEqual([
      ["user", "question"],
      ["user", "note"],
    ])
  })

  it("rule 61: starts a queued tool turn at its call when the tool injects chat", async () => {
    const provider = new ScriptedProvider([{ text: "answer" }])
    const annotate = defineTool({
      description: "Add a note",
      execute: async (state) => {
        await state.injectMessage({ role: "user", content: "note" })
        return ok("annotated")
      },
    })
    await using(spindleDriver, { provider, prompt: currentOnly, tools: { annotate } }, async (session, thread) => {
      const state = await session.state(thread)
      state.queueTool("annotate", {})
      await session.settled(thread)
    })
    const messages = historyOf(provider.requests[0])
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool", "user"])
    expect(messages[0]).toMatchObject({ toolCalls: [{ name: "annotate" }] })
    expect(messages[2]?.content).toBe("note")
  })

  it("rule 61: excludes previous chat and tool calls when a queued tool starts a later run", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "old", name: "work", arguments: {} }] },
      { text: "old answer" },
      { text: "new answer" },
    ])
    await using(
      spindleDriver,
      { provider, prompt: currentOnly, tools: { work: stubTool("Work", "done") } },
      async (session, thread) => {
        await session.send(thread, "old question")
        const state = await session.state(thread)
        state.queueTool("work", {})
        await session.settled(thread)
      },
    )
    const messages = historyOf(provider.requests[2])
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"])
    expect(messages[0]).toMatchObject({ toolCalls: [{ id: expect.stringMatching(/^queued-/), name: "work" }] })
  })

  for (const delivery of ["queued", "injected"] as const) {
    it(`rule 61: B sees the opening send and the ${delivery} message from A's handoff tool`, async () => {
      const publish = defineTool({
        description: "Send a note to the reviewer",
        execute: async (state) => {
          const note = { role: "assistant" as const, content: "review note" }
          if (delivery === "queued") await state.queueMessage(note)
          else await state.injectMessage(note)
          return ok("sent")
        },
      })
      const providerA = new ScriptedProvider([
        { ...(delivery === "queued" && { text: "draft" }), toolCalls: [{ id: "c1", name: "publish", arguments: {} }] },
      ])
      const providerB = new ScriptedProvider([{ text: "reviewed" }])
      await usingDual(
        spindleDriver,
        {
          providerA,
          providerB,
          promptA: currentOnly,
          promptB: currentOnly,
          tools: { publish },
          sideA: { stopTool: "publish" },
          agent: { maxSessionTurns: 2 },
        },
        (session, thread) => session.send(thread, "write"),
      )
      expect(historyOf(providerB.requests[0]).map(sideOf)).toEqual([
        ["assistant", "write", []],
        ...(delivery === "queued" ? [["user", "draft"]] : []),
        ["user", "review note"],
      ])
    })
  }

  it("rule 61: a preamble stored by before_create_message precedes the delivery in the request", async () => {
    const prepend = defineHook({
      hook: "before_create_message",
      id: "prepend",
      execute: async (state, message) => {
        if (message.content === "question") await state.injectMessage({ role: "user", content: "preamble" })
        return message
      },
    })
    const provider = new ScriptedProvider([{ text: "answer" }])
    await using(
      spindleDriver,
      { provider, prompt: currentOnly, hooks: [prepend], agent: { hooks: [prepend.id] } },
      (session, thread) => session.send(thread, "question"),
    )
    expect(historyOf(provider.requests[0]).map(sideOf)).toEqual([
      ["user", "preamble"],
      ["user", "question"],
    ])
  })

  it.effect(
    "§5.2: HistoryView uses turnStartSeq to exclude past turns across side switches while keeping current-turn injections and synthetic filter_messages rows",
    () =>
      Effect.gen(function* () {
        expectTypeOf<HistoryView["turnStartSeq"]>().toEqualTypeOf<number>()
        const injectTool = defineTool({
          description: "Inject a note mid-turn",
          execute: async (state: ThreadState) => {
            await state.injectMessage({ role: "user", content: "mid-turn note" })
            return ok("injected")
          },
        })
        const addSynthetic = defineHook({
          hook: "filter_messages",
          id: "add_synthetic",
          execute: async (_state, messages) => [
            ...messages,
            { id: "synthetic-1", role: "assistant", content: "synthetic for B", created_at: 0 },
          ],
        })
        const providerA = new ScriptedProvider([
          { toolCalls: [{ id: "ca1", name: "inject_tool", arguments: {} }] },
          { text: "A1" },
          { text: "A2" },
        ])
        const providerB = new ScriptedProvider([{ text: "B1" }])
        const setup = dualProject({
          providerA,
          providerB,
          tools: { inject_tool: injectTool },
          hooks: [addSynthetic],
          promptA: { includeChat: false, includePastTools: false, tools: ["inject_tool"] },
          promptB: { includeChat: false, includePastTools: false, hooks: ["add_synthetic"], tools: [] },
          agent: { maxSessionTurns: 3 },
        })
        yield* Effect.gen(function* () {
          const thread = yield* createThread("pair")
          yield* appendMessages(thread.id, [
            { role: "user", content: "old user" },
            { role: "assistant", content: "old assistant" },
          ])
          const { outcome } = yield* sendMessage(thread.id, "fresh start")
          expect(outcome).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 4 })
        }).pipe(Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory()))))
        // Side A step 1: old history (< turnStartSeq) excluded.
        expect(historyOf(providerA.requests[0]).map(sideOf)).toEqual([["user", "fresh start"]])
        // Side A step 2: mid-turn injection did not advance turnStartSeq past "fresh start".
        expect(historyOf(providerA.requests[1]).map(sideOf)).toEqual([
          ["user", "fresh start"],
          ["assistant", null, ["ca1"]],
          ["tool", "ca1"],
          ["user", "mid-turn note"],
        ])
        // B has no earlier turn in this execution. It sees the opening message and the injected note.
        expect(historyOf(providerB.requests[0]).map(sideOf)).toEqual([
          ["assistant", "fresh start", []],
          ["assistant", "mid-turn note", []],
          ["user", "A1"],
          ["user", "synthetic for B"],
        ])
        // Side A turn 3: past history (< turnStartSeq) excluded; only B1 is in the current turn.
        expect(historyOf(providerA.requests[2]).map(sideOf)).toEqual([["user", "B1"]])
      }),
  )

  it.effect(
    "§5.1, §5.2, §5.4, §5.6: a prompt x prompt exchange on a 1,000-message thread issues the same SQL statements and history reads as on a 10-message thread",
    () =>
      Effect.gen(function* () {
        const measure = (seedCount: number) =>
          Effect.gen(function* () {
            const reads = { count: 0 }
            let totalSql = 0
            let stepSql = 0
            const perStepSql: Array<number> = []
            const observeSql: Statement.Transformer = (statement) => {
              totalSql += 1
              stepSql += 1
              return Effect.succeed(statement)
            }
            const tickStep =
              (response: {
                readonly text?: string
                readonly toolCalls?: ReadonlyArray<{
                  readonly id: string
                  readonly name: string
                  readonly arguments: Record<string, unknown>
                }>
              }) =>
              () => {
                perStepSql.push(stepSql)
                stepSql = 0
                return response
              }
            const providerA = new ScriptedProvider([
              tickStep({ toolCalls: [{ id: "ca1", name: "work", arguments: {} }] }),
              tickStep({ text: "A done" }),
            ])
            const providerB = new ScriptedProvider([
              tickStep({ toolCalls: [{ id: "cb1", name: "check", arguments: {} }] }),
              tickStep({ text: "B done" }),
            ])
            const setup = dualProject({
              providerA,
              providerB,
              tools: { work: stubTool("Work", "worked"), check: stubTool("Check", "checked") },
              promptA: { includeChat: false, includePastTools: false, tools: ["work"] },
              promptB: { includeChat: false, includePastTools: false, tools: ["check"] },
              agent: { maxSessionTurns: 2 },
            })
            const outcome = yield* Effect.gen(function* () {
              const thread = yield* createThread("pair")
              yield* appendMessages(
                thread.id,
                Array.from({ length: seedCount }, (_, index) => ({
                  role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
                  content: `seeded ${index}`,
                })),
              )
              const { outcome } = yield* sendMessage(thread.id, "go").pipe(
                Effect.provideService(Statement.CurrentTransformer, observeSql),
              )
              perStepSql.push(stepSql)
              return outcome
            }).pipe(
              Effect.provide(
                Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), countingStore(reads))),
              ),
            )
            expect(outcome).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 4 })
            return { totalSql, perStepSql, historyReads: reads.count }
          })

        const short = yield* measure(10)
        const long = yield* measure(1000)
        expect(short.totalSql).toBeGreaterThan(0)
        expect(long.totalSql).toBe(short.totalSql)
        expect(long.perStepSql).toEqual(short.perStepSql)
        expect([short.historyReads, long.historyReads]).toEqual([1, 1])
      }),
  )
})
