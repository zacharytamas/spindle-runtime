import { expect, it } from "@effect/vitest"
import { defineHook, defineTool } from "@standardagents/spec"
import { Deferred, Effect, Fiber, Layer, Scheduler } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { gate, ok, project } from "../../../conformance/src/scenarios/harness.ts"
import { dualProject } from "../../../conformance/src/scenarios/sides/fixtures.ts"
import { newSecrets } from "../../src/execution/env.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage } from "../../src/execution/trigger.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { layer } from "../../src/store/sqlite.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf } from "../spindle-driver.ts"
import { inMemory } from "../store/contract-fixtures.ts"

it.effect("a refused idle settlement reaches the sender without a second settlement as failed", () =>
  Effect.gen(function* () {
    const thread = yield* createThread("assistant")
    const sql = yield* SqlClient
    yield* sql`CREATE TRIGGER refuse_idle BEFORE UPDATE OF run_state ON threads WHEN NEW.run_state = 'idle'
      BEGIN SELECT RAISE(ABORT, 'idle settlement refused'); END`
    const result = yield* Effect.result(sendMessage(thread.id, "go"))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SqlError" } })
    expect((yield* ThreadStore.use((s) => s.getThread(thread.id))).status.state).toBe("running")
  }).pipe(
    Effect.provide(
      Layer.merge(
        registryOf(project({ provider: new ScriptedProvider([{ text: "done" }]) })),
        Layer.provideMerge(supervisorLayer(), layer.pipe(Layer.provideMerge(SqliteLive({ filename: ":memory:" })))),
      ),
    ),
  ),
)

it.effect("refuses a stop during an abort hold and runs queued work when the tool returns", () => {
  const entered = gate()
  const leave = gate()
  const tool = defineTool({
    description: "Wait for release",
    execute: async () => {
      entered.release()
      await leave.opened
      return ok("done")
    },
  })
  const registry = registryOf(
    project({
      provider: new ScriptedProvider([{ toolCalls: [{ id: "1", name: "wait", arguments: {} }] }, { text: "resumed" }]),
      tools: { wait: tool },
    }),
  )
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const supervisor = yield* ThreadSupervisor
    const sent = yield* Effect.forkChild(sendMessage(id, "go"))
    yield* Effect.promise(() => entered.opened)
    const settlement = yield* supervisor.abort(id)
    yield* supervisor.control(id).queueMessage({ role: "user", content: "queued" }, newSecrets(), { kind: "external" })
    const stopped = yield* supervisor.stop(id)
    leave.release()
    expect(stopped).toBe(false)
    expect(settlement?.isDone()).toBe(false)
    expect((yield* Fiber.join(sent)).outcome?.reason).toBe("aborted_by_user")
    yield* supervisor.settled(id)
    expect((yield* supervisor.status(id)).reason).toBe("stop_on_response")
  }).pipe(
    Effect.provide(
      Layer.merge(
        registry,
        Layer.provideMerge(supervisorLayer(), layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))),
      ),
    ),
  )
})

it.effect("an exiting abort followed by a holding abort leaves queued work for the next trigger", () => {
  const entered = gate()
  const leave = gate()
  const provider = new ScriptedProvider([
    { toolCalls: [{ id: "1", name: "wait", arguments: {} }] },
    { text: "resumed" },
  ])
  const wait = defineTool({
    description: "Wait for release",
    execute: async () => {
      entered.release()
      await leave.opened
      return ok("done")
    },
  })
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const supervisor = yield* ThreadSupervisor
    const sent = yield* Effect.forkChild(sendMessage(id, "go"))
    yield* Effect.promise(() => entered.opened)
    yield* supervisor.control(id).queueMessage({ role: "user", content: "queued" }, newSecrets(), { kind: "external" })
    yield* supervisor.abort(id, true)
    const stopped = yield* supervisor.stop(id)
    yield* supervisor.abort(id)
    leave.release()
    expect(stopped).toBe(false)
    expect((yield* Fiber.join(sent)).outcome?.reason).toBe("aborted_by_user")
    yield* supervisor.settled(id)
    expect((yield* supervisor.status(id)).reason).toBe("aborted_by_user")
    expect(yield* RunStore.use((store) => store.queueLength(id))).toBe(1)
    expect(provider.requests).toHaveLength(1)
  }).pipe(
    Effect.ensuring(Effect.sync(leave.release)),
    Effect.provide(
      Layer.merge(
        registryOf(project({ provider, tools: { wait } })),
        Layer.provideMerge(supervisorLayer(), layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))),
      ),
    ),
  )
})

for (const mode of ["abort", "terminate", "abort after provider failure"] as const)
  it.effect(`preserves the sender's outcome on ${mode} while committed metadata is pending`, () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<boolean>()
      const entered = gate()
      const release = gate()
      const registry = registryOf(
        project({
          provider: new ScriptedProvider(
            mode === "abort after provider failure"
              ? [
                  { toolCalls: [{ id: "call", name: "missing", arguments: {} }] },
                  { reject: { code: "invalid_request", message: "rejected" } },
                ]
              : [{ text: "reply" }],
            {
              getResponseMetadata: async () => {
                entered.release()
                await release.opened
                return {}
              },
            },
          ),
        }),
      )
      const stores = Layer.effect(
        RunStore,
        RunStore.use((store) =>
          Effect.succeed({
            ...store,
            settle: (...args: Parameters<typeof store.settle>) =>
              store
                .settle(...args)
                .pipe(
                  Effect.tap(() =>
                    Effect.flatMap(Scheduler.PreventSchedulerYield, (guarded) => Deferred.succeed(committed, guarded)),
                  ),
                ),
          }),
        ),
      ).pipe(Layer.provideMerge(layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))))
      yield* Effect.gen(function* () {
        const { id } = yield* createThread("assistant")
        const supervisor = yield* ThreadSupervisor
        const sent = yield* Effect.forkChild(sendMessage(id, "go"))
        yield* Effect.promise(() => entered.opened)
        expect(yield* Deferred.await(committed), "the scheduler is guarded through the return from commit").toBe(true)
        if (mode === "terminate") yield* supervisor.control(id).terminate({ kind: "external" })
        else yield* supervisor.abort(id)
        if (mode === "abort after provider failure") {
          release.release()
          const { outcome, status } = yield* Fiber.join(sent)
          expect(status.reason).toBe("step_error")
          expect(outcome).toMatchObject({ status: "failed", reason: "step_error", error: { message: "rejected" } })
          expect(outcome?.modelCalls).toHaveLength(2)
          expect(outcome?.trace.length).toBeGreaterThan(0)
          return
        }
        const { outcome, status } = yield* Fiber.join(sent)
        expect(status.reason).toBe("stop_on_response")
        expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", trace: [], modelCalls: [] })
      }).pipe(
        Effect.ensuring(Effect.sync(release.release)),
        Effect.provide(Layer.merge(registry, Layer.provideMerge(supervisorLayer(), stores))),
      )
    }),
  )

it.effect("a queue that repeatedly asks to continue without a delivery still lets the operator stop", () =>
  Effect.gen(function* () {
    const retrying = gate()
    let attempts = 0
    const stores = Layer.effect(
      RunStore,
      RunStore.use((store) =>
        Effect.succeed({
          ...store,
          settle: (...args: Parameters<typeof store.settle>) => {
            if (args[2].reason !== "awaiting_human") return store.settle(...args)
            if (++attempts > 1000) return Effect.die("the stop fiber never ran")
            if (attempts === 1) queueMicrotask(retrying.release)
            return Effect.succeed("continue" as const)
          },
        }),
      ),
    ).pipe(Layer.provideMerge(layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))))
    yield* Effect.gen(function* () {
      const { id } = yield* createThread("assistant")
      const supervisor = yield* ThreadSupervisor
      yield* supervisor
        .control(id)
        .queueMessage({ role: "assistant", content: "same side" }, newSecrets(), { kind: "external" })
      yield* Effect.promise(() => retrying.opened)
      expect(yield* supervisor.stop(id)).toBe(true)
      expect((yield* supervisor.settled(id))?.reason).toBe("aborted_by_user")
    }).pipe(
      Effect.provide(
        Layer.merge(
          registryOf(project({ provider: new ScriptedProvider([]) })),
          Layer.provideMerge(supervisorLayer(), stores),
        ),
      ),
    )
  }),
)

// M1c-4 rule 1: a sender whose entry is set aside as unreadable is told so, and is not told it was taken.
it.effect("a sender whose queued entry fails delivery learns that it was not delivered", () => {
  const entered = gate()
  const leave = gate()
  const wait = defineTool({
    description: "Wait for release",
    execute: async () => {
      entered.release()
      await leave.opened
      return ok("done")
    },
  })
  const provider = new ScriptedProvider([
    { toolCalls: [{ id: "1", name: "wait", arguments: {} }] },
    { text: "after the tool" },
  ])
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const supervisor = yield* ThreadSupervisor
    const sql = yield* SqlClient
    const first = yield* Effect.forkChild(sendMessage(id, "go"))
    yield* Effect.promise(() => entered.opened)
    const admitted = yield* Deferred.make<number>()
    const waiting = gate()
    const second = yield* Effect.forkChild(
      supervisor.send(id, "unreadable later", {
        onAdmitted: (seq) => Deferred.doneUnsafe(admitted, Effect.succeed(seq)),
        onWaiting: () => Effect.sync(waiting.release),
      }),
    )
    const seq = yield* Deferred.await(admitted)
    yield* Effect.promise(() => waiting.opened)
    yield* sql`UPDATE queue SET payload = 'unreadable' WHERE seq = ${seq}`
    leave.release()
    yield* Fiber.join(first)
    const [row] = yield* sql<{ disposition: string }>`SELECT disposition FROM queue WHERE seq = ${seq}`
    expect(row?.disposition).toBe("failed_delivery")
    expect(yield* Fiber.join(second)).toMatchObject({ failedDelivery: true, stillQueued: false })
    expect(provider.requests).toHaveLength(2)
  }).pipe(
    Effect.ensuring(Effect.sync(leave.release)),
    Effect.provide(
      Layer.merge(
        registryOf(project({ provider, tools: { wait } })),
        Layer.provideMerge(supervisorLayer(), layer.pipe(Layer.provideMerge(SqliteLive({ filename: ":memory:" })))),
      ),
    ),
  )
})

for (const [title, stop] of [
  ["a sender whose claim first runs older work for the opposite side waits for its own delivery", false],
  ["a sender reclaims its entry after older work on the opposite side stops cooperatively", true],
] as const)
  it.effect(title, () => {
    const providerA = new ScriptedProvider([
      { toolCalls: [{ id: "park", name: "park", arguments: {} }] },
      { text: "answered the second send" },
    ])
    const providerB = new ScriptedProvider([
      stop ? { toolCalls: [{ id: "stop", name: "stop", arguments: {} }] } : { text: "answered parked work" },
    ])
    const stopTool = defineTool({
      description: "Stop this run",
      execute: async (state) => {
        state.execution?.stop()
        return ok("stopped")
      },
    })
    const park = defineTool({
      description: "Leave work for B in the next session",
      execute: async (state) => {
        await state.queueMessage({ role: "assistant", content: "for B" })
        return ok("parked")
      },
    })
    const setup = dualProject({
      providerA,
      providerB,
      tools: { park, stop: stopTool },
      sideA: { stopTool: "park" },
      agent: { maxSessionTurns: 1 },
    })
    return Effect.gen(function* () {
      const thread = yield* createThread("pair")
      const first = yield* sendMessage(thread.id, "first")
      expect(first.outcome?.reason).toBe("max_session_turns")
      const second = yield* sendMessage(thread.id, "second")
      expect(second.outcome?.reason).toBe("max_session_turns")
      expect(providerB.requests).toHaveLength(1)
      expect(providerA.requests[1]?.messages).toContainEqual({ role: "user", content: "second" })
      expect(yield* RunStore.use((store) => store.queueLength(thread.id))).toBe(0)
    }).pipe(
      Effect.provide(
        Layer.merge(
          registryOf(setup),
          Layer.provideMerge(supervisorLayer(), layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))),
        ),
      ),
    )
  })

it.effect("a forceTurn from a delivery to a human expires before queued work continues", () => {
  const hook = defineHook({
    hook: "after_create_message",
    id: "request_human",
    execute: async (state, message) => {
      if (message.content === "for human") state.execution?.forceTurn("b")
    },
  })
  const provider = new ScriptedProvider([{ text: "first step" }, { text: "second step" }])
  const setup = project({
    provider,
    hooks: [hook],
    agent: { hooks: [hook.id] },
    side: { stopOnResponse: false, maxSteps: 2 },
  })
  return Effect.gen(function* () {
    const { id } = yield* (yield* ThreadStore).createThread({ agentId: "assistant" })
    const runs = yield* RunStore
    const supervisor = supervisorLayer({
      observe: (event) =>
        event.type === "trace" && event.entry.phase === "stop" && event.entry.detail === "awaiting_human"
          ? Effect.asVoid(
              runs.admit(
                id,
                { kind: "message", message: { role: "user", content: "for prompt" } },
                { holder: "waiting", flowId: "waiting" },
                { kind: "external" },
              ),
            ).pipe(Effect.orDie)
          : Effect.void,
    })
    yield* Effect.gen(function* () {
      const s = yield* ThreadSupervisor
      yield* s.control(id).queueMessage({ role: "assistant", content: "for human" }, newSecrets(), { kind: "external" })
      expect(yield* s.settled(id)).toMatchObject({ reason: "max_side_steps", steps: 2 })
    }).pipe(Effect.provide(supervisor))
  }).pipe(Effect.provide(Layer.merge(registryOf(setup), inMemory)))
})

it.effect("an abort observing a counted session cap preserves its reason, counter reset, and pending work", () => {
  const queue = defineTool({
    description: "Queue the next request",
    execute: async (state) => {
      await state.queueMessage({ role: "user", content: "next" })
      return ok("queued")
    },
  })
  const provider = new ScriptedProvider([
    { toolCalls: [{ id: "q", name: "queue", arguments: {} }] },
    { text: "follow-up" },
  ])
  const setup = project({ provider, tools: { queue }, side: { stopTool: "queue" }, agent: { maxSessionTurns: 1 } })
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const supervisor = yield* ThreadSupervisor
    let observed = false
    const delivery = yield* supervisor.send(id, "go", {
      observe: (event) => {
        if (event.type !== "trace" || event.entry.phase !== "stop" || event.entry.detail !== "max_session_turns")
          return Effect.void
        observed = true
        return Effect.asVoid(supervisor.abort(id))
      },
    })
    yield* supervisor.settled(id)
    const sql = yield* SqlClient
    const [row] = yield* sql<{ session_turns: number }>`SELECT session_turns FROM threads WHERE id = ${id}`
    expect({
      observed,
      reason: delivery.outcome?.reason,
      storedReason: (yield* supervisor.status(id)).reason,
      sessionTurns: row?.session_turns,
      pending: yield* RunStore.use((store) => store.queueLength(id)),
      requests: provider.requests.length,
    }).toEqual({
      observed: true,
      reason: "max_session_turns",
      storedReason: "max_session_turns",
      sessionTurns: 0,
      pending: 1,
      requests: 1,
    })
  }).pipe(Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory))))
})

it.effect("a repeated setup failure returns after one reclaim and reports its message still queued", () => {
  let attempts = 0
  const setup = project({
    provider: new ScriptedProvider([]),
    model: {
      provider: () => {
        attempts++
        throw new Error("model setup failed")
      },
    },
  })
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const delivery = yield* sendMessage(id, "go")
    expect({
      attempts,
      stillQueued: delivery.stillQueued,
      reason: delivery.outcome?.reason,
      pending: yield* RunStore.use((store) => store.queueLength(id)),
    }).toEqual({
      attempts: 2,
      stillQueued: true,
      reason: "fatal_error",
      pending: 1,
    })
  }).pipe(Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory))))
})
