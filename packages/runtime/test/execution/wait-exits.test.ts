import { expect, it } from "@effect/vitest"
import { defineTool, type ThreadState } from "@standardagents/spec"
import { Effect, Exit, Fiber, Layer, Scope } from "effect"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { gate, ok, project } from "../../../conformance/src/scenarios/harness.ts"
import { newSecrets } from "../../src/execution/env.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread } from "../../src/execution/trigger.ts"
import { external } from "../../src/store/model.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { registryOf } from "../spindle-driver.ts"
import { inMemory } from "../store/contract-fixtures.ts"

// docs/design/thread-ownership.md, the abort in the wait for callbacks: a run that waits for a nested tool it did
// not await has already ended, and whatever ends the wait keeps that end and its rule for queued work.
// Each test queues a message while the run waits, so the end of the wait has work it could wrongly take.
const held = (options: { readonly stepCap?: number } = {}) => {
  const entered = gate()
  const leave = gate()
  const inner = defineTool({
    description: "Wait until the test lets it return",
    execute: async () => {
      entered.release()
      await leave.opened
      return ok("inner")
    },
  })
  const outer = defineTool({
    description: "Start the inner tool and do not await it",
    execute: async (state: ThreadState) => {
      void state.invokeTool("inner", {}).catch(() => {})
      return ok("outer")
    },
  })
  const provider = new ScriptedProvider([
    { toolCalls: [{ id: "1", name: "wait", arguments: {} }] },
    { text: "done" },
    { text: "next reply" },
  ])
  const registry = registryOf(project({ provider, tools: { wait: outer, inner } }))
  const start = Effect.gen(function* () {
    const supervisor = yield* ThreadSupervisor
    const { id } = yield* createThread("assistant")
    const waiting = gate()
    const sent = yield* Effect.forkDetach(supervisor.send(id, "go", { onHold: () => Effect.sync(waiting.release) }))
    yield* Effect.promise(() => waiting.opened)
    yield* supervisor.control(id).queueMessage({ role: "user", content: "queued" }, newSecrets(), external)
    return { supervisor, id, sent }
  })
  return { leave, provider, registry, start, supervisor: supervisorLayer(options) }
}

for (const abort of [false, true])
  it.live(
    `keeps the step cap's end and its queued work when the wait ends ${abort ? "by an abort" : "by itself"}`,
    () => {
      const { leave, provider, registry, start, supervisor: layer } = held({ stepCap: 2 })
      return Effect.gen(function* () {
        const { supervisor, id, sent } = yield* start
        if (abort) yield* supervisor.abort(id)
        leave.release()
        const { outcome } = yield* Fiber.join(sent)
        yield* supervisor.settled(id)
        const queued = yield* RunStore.use((store) => store.queueLength(id))
        expect({ reason: outcome?.reason, queued, requests: provider.requests.length }).toEqual({
          reason: "max_total_steps",
          queued: 1,
          requests: 2,
        })
      }).pipe(
        Effect.ensuring(Effect.sync(leave.release)),
        Effect.provide(Layer.merge(registry, Layer.provideMerge(layer, inMemory))),
        Effect.timeout("5 seconds"),
      )
    },
  )

it.live("delivers no queued work and calls no model when the supervisor closes during the wait", () => {
  const { leave, provider, registry, start, supervisor: layer } = held()
  return Effect.gen(function* () {
    const stores = yield* Layer.build(inMemory)
    const scope = yield* Scope.make()
    const running = yield* Layer.buildWithScope(
      Layer.merge(registry, layer).pipe(Layer.provide(Layer.succeedContext(stores))),
      scope,
    )
    const { id } = yield* start.pipe(Effect.provideContext(running), Effect.provideContext(stores))
    const closed = yield* Effect.forkDetach(Scope.close(scope, Exit.void))
    yield* Effect.yieldNow
    leave.release()
    yield* Fiber.join(closed)
    const queued = yield* RunStore.use((store) => store.queueLength(id)).pipe(Effect.provideContext(stores))
    expect({ queued, requests: provider.requests.length }).toEqual({ queued: 1, requests: 2 })
  }).pipe(Effect.ensuring(Effect.sync(leave.release)), Effect.scoped, Effect.timeout("5 seconds"))
})
