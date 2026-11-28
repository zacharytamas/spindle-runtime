import { describe, expect, it } from "@effect/vitest"
import { defineHook, defineTool, type HandlerDefinition, type ThreadState } from "@standardagents/spec"
import { Effect, Fiber, Layer } from "effect"
import * as Statement from "effect/sql/Statement"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import {
  type HandlerRunOutcome,
  type HandlerSetup,
  handlerOf,
  handlerProject,
} from "../../../conformance/src/scenarios/handlers/fixtures.ts"
import { attempt, ok, project } from "../../../conformance/src/scenarios/harness.ts"
import { appendMessages } from "../../scripts/store-fixtures.ts"
import type { ExecutionOptions } from "../../src/execution/step.ts"
import { layer as supervisorLayer } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage, stateAtRest } from "../../src/execution/trigger.ts"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { layer as storeLayer } from "../../src/store/sqlite.ts"
import { registryOf } from "../spindle-driver.ts"

type HandlerExecutionOptions = ExecutionOptions & { readonly turnCap?: number }

const inMemory = () => Layer.fresh(storeLayer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" }))))

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

const runHandler = (
  setup: HandlerSetup,
  content: string,
  options?: HandlerExecutionOptions,
  defaults?: HandlerExecutionOptions,
) =>
  Effect.gen(function* () {
    const thread = yield* createThread(setup.agent?.name ?? "relay")
    const delivery = yield* sendMessage(thread.id, content, options as ExecutionOptions)
    return { threadId: thread.id, delivery, outcome: delivery.outcome as HandlerRunOutcome | undefined }
  }).pipe(
    Effect.provide(
      Layer.merge(
        registryOf(handlerProject(setup)),
        Layer.provideMerge(supervisorLayer(defaults as ExecutionOptions), inMemory()),
      ),
    ),
  )

describe("handler runtime loading, turnCap, stopSession, and performance guard", () => {
  it.effect(
    "rule 8: runtime loading rejects an unbranded handler object with SetupError without invoking execute",
    () =>
      Effect.gen(function* () {
        let called = false
        const unbranded = {
          description: "Missing defineHandler brand",
          execute: async () => {
            called = true
          },
        } as unknown as HandlerDefinition
        const { outcome } = yield* runHandler(
          {
            sideA: { handler: "plain" },
            sideB: { human: true },
            handlers: { plain: unbranded },
          },
          "go",
        )
        expect(called).toBe(false)
        expect(outcome).toMatchObject({ status: "failed", reason: "fatal_error", steps: 0 })
        expect(outcome?.error?.message).toMatch(/defineHandler|brand|handler/i)
        expect(outcome?.error?.message).not.toMatch(/does not yet execute handler/i)
      }),
  )

  it.effect("rule 13: validates turnCap options and enforces supervisor default turnCap on handler x handler", () =>
    Effect.gen(function* () {
      const ping_a = handlerOf(async (state) => {
        await state.injectMessage({ role: "assistant", content: "a" })
      })
      const ping_b = handlerOf(async (state) => {
        await state.injectMessage({ role: "user", content: "b" })
      })
      const setup: HandlerSetup = {
        sideA: { handler: "ping_a" },
        sideB: { handler: "ping_b" },
        handlers: { ping_a, ping_b },
      }
      // Invalid turnCap values are rejected as InvalidOption just like stepCap.
      yield* Effect.gen(function* () {
        const { id } = yield* createThread("relay")
        for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          const result = yield* Effect.result(sendMessage(id, "go", { turnCap: bad } as ExecutionOptions))
          expect(result, `turnCap=${String(bad)} should fail with InvalidOption`).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "InvalidOption" },
          })
        }
      }).pipe(
        Effect.provide(
          Layer.merge(registryOf(handlerProject(setup)), Layer.provideMerge(supervisorLayer(), inMemory())),
        ),
      )

      // Supervisor default turnCap stops uncapped handler x handler ping-pong with max_total_turns.
      const { outcome } = yield* runHandler(setup, "go", undefined, { turnCap: 4 })
      expect(outcome).toMatchObject({ status: "idle", reason: "max_total_turns", steps: 0, modelCalls: [] })
      expect(outcome?.handlerCalls).toHaveLength(4)
    }),
  )

  it.effect(
    "rules 14, 18: state.stopSession() rejects at rest, rejects invalid options, and yields to cooperative stop()",
    () =>
      Effect.gen(function* () {
        // At rest: rejects (not with the M1 "not available" stub).
        yield* Effect.gen(function* () {
          const { id } = yield* createThread("assistant")
          const rest = yield* stateAtRest(id)
          const restMessage = yield* Effect.promise(() =>
            rest.stopSession().then(
              () => "resolved",
              (error: unknown) => (error instanceof Error ? error.message : String(error)),
            ),
          )
          expect(restMessage).not.toBe("resolved")
          expect(restMessage).not.toMatch(/not available in this version/i)
        }).pipe(
          Effect.provide(
            Layer.merge(
              registryOf(project({ provider: new ScriptedProvider([]) })),
              Layer.provideMerge(supervisorLayer(), inMemory()),
            ),
          ),
        )

        // Invalid options passed to stopSession() during an active execution reject cleanly.
        let badResult = ""
        let badNotify = ""
        let badStatus = ""
        let nonObject = ""
        const check_stop = defineTool({
          description: "Validate stopSession arguments then call stopSession",
          execute: async (state: ThreadState) => {
            nonObject = await attempt(() => Reflect.apply(state.stopSession, state, ["bad"]))
            badResult = await attempt(() => Reflect.apply(state.stopSession, state, [{ result: 42 }]))
            badNotify = await attempt(() => Reflect.apply(state.stopSession, state, [{ notifyParent: 42 }]))
            badStatus = await attempt(() => Reflect.apply(state.stopSession, state, [{ status: 42 }]))
            await state.stopSession()
            return ok("stopped")
          },
        })
        const provider = new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "check_stop", arguments: {} }] }])
        yield* Effect.gen(function* () {
          const { id } = yield* createThread("assistant")
          const { outcome } = yield* sendMessage(id, "go")
          expect(outcome).toMatchObject({ status: "idle", reason: "state_stop_session", steps: 1 })
          expect([nonObject, badResult, badNotify, badStatus]).toEqual([
            "InvalidArguments",
            "InvalidArguments",
            "InvalidArguments",
            "InvalidArguments",
          ])
        }).pipe(
          Effect.provide(
            Layer.merge(
              registryOf(project({ provider, tools: { check_stop } })),
              Layer.provideMerge(supervisorLayer(), inMemory()),
            ),
          ),
        )

        // Rule 14.1 vs 14.2: cooperative stop() called before stopSession() settles aborted, not state_stop_session.
        const stop_then_session = handlerOf(async (state) => {
          state.execution?.stop()
          await state.stopSession()
        })
        const { outcome } = yield* runHandler(
          {
            sideA: { handler: "stop_then_session" },
            sideB: { human: true },
            handlers: { stop_then_session },
          },
          "go",
        )
        expect(outcome).toMatchObject({ status: "idle", reason: "aborted", steps: 0 })
      }),
  )

  it.effect(
    "§5.3, §5.4, §5.6: a handler turn on a 5,000-message thread reads zero history and issues the same SQL statements as on a 10-message thread",
    () =>
      Effect.gen(function* () {
        const measure = (seedCount: number) =>
          Effect.gen(function* () {
            const reads = { count: 0 }
            let totalSql = 0
            const observeSql: Statement.Transformer = (statement) => {
              totalSql += 1
              return Effect.succeed(statement)
            }
            const seen: Array<string | null> = []
            const fast_handler = handlerOf(async (_state, message) => {
              seen.push(message.content)
            })
            const setup = handlerProject({
              sideA: { handler: "fast_handler" },
              sideB: { human: true },
              handlers: { fast_handler },
            })
            const outcome = yield* Effect.gen(function* () {
              const thread = yield* createThread("relay")
              yield* appendMessages(
                thread.id,
                Array.from({ length: seedCount }, (_, index) => ({
                  role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
                  content: `seeded ${index}`,
                })),
              )
              const { outcome } = yield* sendMessage(thread.id, "live").pipe(
                Effect.provideService(Statement.CurrentTransformer, observeSql),
              )
              return outcome
            }).pipe(
              Effect.provide(
                Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), countingStore(reads))),
              ),
            )
            expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
            expect(seen).toEqual(["live"])
            return { totalSql, historyReads: reads.count }
          })

        const short = yield* measure(10)
        const long = yield* measure(5000)
        expect(short.totalSql).toBeGreaterThan(0)
        expect(long.totalSql).toBe(short.totalSql)
        expect([short.historyReads, long.historyReads]).toEqual([0, 0])
      }),
  )

  it.effect("intra-execution updateMessage and deleteMessage keep buffered peer-handler deliveries in sync", () => {
    const received: Array<{ id: string; content: string | null; metadata: unknown }> = []
    let secondId = ""
    let deletedId = ""
    const writer = handlerOf(async (state) => {
      const first = await state.injectMessage({ role: "assistant", content: "draft-1" })
      await state.updateMessage(first.id, { content: "final-1", metadata: { revised: true } })
      const removed = await state.injectMessage({ role: "assistant", content: "drop-before-handoff" })
      await state.deleteMessage(removed.id)
      const second = await state.injectMessage({ role: "assistant", content: "draft-2" })
      secondId = second.id
      const third = await state.injectMessage({ role: "assistant", content: "drop-from-inbox" })
      deletedId = third.id
    })
    const reader = handlerOf(async (state, message) => {
      received.push({ id: message.id, content: message.content, metadata: message.metadata })
      if (message.content === "final-1") {
        await state.updateMessage(secondId, { content: "final-2", metadata: { fromPeer: true } })
        await state.deleteMessage(deletedId)
      }
    })
    const setup = handlerProject({
      sideA: { handler: "writer" },
      sideB: { handler: "reader" },
      handlers: { writer, reader },
    })
    return Effect.gen(function* () {
      const thread = yield* createThread("relay")
      const { outcome } = yield* sendMessage(thread.id, "go")
      expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
      expect(received.map((m) => [m.content, m.metadata])).toEqual([
        ["final-1", { revised: true }],
        ["final-2", { fromPeer: true }],
      ])
    }).pipe(Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory()))))
  })

  it.effect(
    "after_create_message edits and deletes on a queued inbound message take effect before handler delivery",
    () => {
      const received: Array<{ content: string | null; metadata: unknown }> = []
      const revise = defineHook({
        hook: "after_create_message",
        id: "revise_inbound",
        execute: async (state, message) => {
          if (message.content === "edit-me")
            await state.updateMessage(message.id, { content: "edited", metadata: { fromHook: true } })
          if (message.content === "delete-me") await state.deleteMessage(message.id)
        },
      })
      const receiver = handlerOf(async (_state, message) => {
        received.push({ content: message.content, metadata: message.metadata })
      })
      const setup = handlerProject({
        sideA: { handler: "receiver" },
        sideB: { human: true },
        handlers: { receiver },
        hooks: [revise],
        agent: { hooks: ["revise_inbound"] },
      })
      return Effect.gen(function* () {
        const thread = yield* createThread("relay")
        expect((yield* sendMessage(thread.id, "edit-me")).outcome).toMatchObject({
          status: "idle",
          reason: "handler_idle",
          steps: 0,
        })
        expect((yield* sendMessage(thread.id, "delete-me")).outcome).toMatchObject({
          status: "idle",
          reason: "handler_idle",
          steps: 0,
        })
        expect(received).toEqual([{ content: "edited", metadata: { fromHook: true } }])
      }).pipe(Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory()))))
    },
  )

  it.effect("external stateAtRest edits and deletes on buffered peer messages take effect before dispatch", () => {
    const received: Array<{ content: string | null; metadata: unknown }> = []
    let secondId = ""
    let thirdId = ""
    let onFirstReady: (() => void) | undefined
    const firstReady = new Promise<void>((resolve) => {
      onFirstReady = resolve
    })
    let releaseFirst: (() => void) | undefined
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const writer = handlerOf(async (state) => {
      await state.injectMessage({ role: "assistant", content: "first" })
      secondId = (await state.injectMessage({ role: "assistant", content: "stale" })).id
      thirdId = (await state.injectMessage({ role: "assistant", content: "to-delete" })).id
    })
    const reader = handlerOf(async (_state, message) => {
      received.push({ content: message.content, metadata: message.metadata })
      if (message.content === "first") {
        onFirstReady?.()
        await firstDone
      }
    })
    const setup = handlerProject({
      sideA: { handler: "writer" },
      sideB: { handler: "reader" },
      handlers: { writer, reader },
    })
    return Effect.gen(function* () {
      const thread = yield* createThread("relay")
      const running = yield* Effect.forkChild(sendMessage(thread.id, "go"))
      yield* Effect.promise(() => firstReady)
      const rest = yield* stateAtRest(thread.id)
      yield* Effect.promise(() => rest.updateMessage(secondId, { content: "refreshed", metadata: { ext: true } }))
      yield* Effect.promise(() => rest.deleteMessage(thirdId))
      releaseFirst?.()
      const { outcome } = yield* Fiber.join(running)
      expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
      expect(received).toEqual([
        { content: "first", metadata: {} },
        { content: "refreshed", metadata: { ext: true } },
      ])
    }).pipe(
      Effect.ensuring(Effect.sync(() => releaseFirst?.())),
      Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory()))),
    )
  })

  it.effect("handler-invoked tools register declared secrets before validation or execution", () => {
    const secret = "handler-tool-secret-998877"
    const leaky = defineTool({
      description: "Declares a secret and leaks it",
      variables: [{ name: "TOOL_SECRET", type: "secret", required: false, description: "Secret" }],
      execute: async (state: ThreadState) => {
        await state.injectMessage({ role: "assistant", content: `out=${secret}` })
        return ok("done")
      },
    })
    const caller = handlerOf(async (state) => {
      await state.invokeTool("leaky", {})
    })
    const setup = handlerProject({
      sideA: { handler: "caller" },
      sideB: { human: true },
      handlers: { caller },
      tools: { leaky },
      agent: { env: { TOOL_SECRET: secret } },
    })
    return Effect.gen(function* () {
      const thread = yield* createThread("relay")
      yield* sendMessage(thread.id, "go")
      const { messages } = yield* (yield* MessageStore).getMessages(thread.id)
      expect(messages.map((m) => m.content)).toEqual(["out=[redacted]", "go"])
    }).pipe(Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory()))))
  })

  it.effect(
    "external stateAtRest edits and deletes while after_create_message pauses take effect before queued handler dispatch",
    () => {
      const received: Array<{ content: string | null; metadata: unknown }> = []
      let pausedId = ""
      let onHookPaused: (() => void) | undefined
      let releaseHook: (() => void) | undefined
      const pause = defineHook({
        hook: "after_create_message",
        id: "pause_inbound",
        execute: async (_state, message) => {
          pausedId = message.id
          onHookPaused?.()
          await new Promise<void>((resolve) => {
            releaseHook = resolve
          })
        },
      })
      const receiver = handlerOf(async (_state, message) => {
        received.push({ content: message.content, metadata: message.metadata })
      })
      const setup = handlerProject({
        sideA: { handler: "receiver" },
        sideB: { human: true },
        handlers: { receiver },
        hooks: [pause],
        agent: { hooks: ["pause_inbound"] },
      })
      return Effect.gen(function* () {
        const thread = yield* createThread("relay")
        const rest = yield* stateAtRest(thread.id)

        const editReady = new Promise<void>((resolve) => {
          onHookPaused = resolve
        })
        const first = yield* Effect.forkChild(sendMessage(thread.id, "before-ext-edit"))
        yield* Effect.promise(() => editReady)
        yield* Effect.promise(() => rest.updateMessage(pausedId, { content: "after-ext-edit", metadata: { ext: 1 } }))
        releaseHook?.()
        yield* Fiber.join(first)

        const delReady = new Promise<void>((resolve) => {
          onHookPaused = resolve
        })
        const second = yield* Effect.forkChild(sendMessage(thread.id, "before-ext-delete"))
        yield* Effect.promise(() => delReady)
        yield* Effect.promise(() => rest.deleteMessage(pausedId))
        releaseHook?.()
        yield* Fiber.join(second)

        expect(received).toEqual([{ content: "after-ext-edit", metadata: { ext: 1 } }])
      }).pipe(
        Effect.ensuring(Effect.sync(() => releaseHook?.())),
        Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory()))),
      )
    },
  )
})
