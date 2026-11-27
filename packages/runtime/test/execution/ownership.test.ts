import { expect, it } from "@effect/vitest"
import { defineTool } from "@standardagents/spec"
import { Effect, Exit, Fiber, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { gate, ok, project } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread } from "../../src/execution/trigger.ts"
import { external } from "../../src/store/model.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { registryOf } from "../spindle-driver.ts"
import { inMemory } from "../store/contract-fixtures.ts"

it.effect("the control poll settles a claim of its live holder with no execution behind it", () =>
  Effect.gen(function* () {
    const supervisor = yield* ThreadSupervisor
    const runs = yield* RunStore
    const { id } = yield* createThread("assistant")
    yield* runs.admit(
      id,
      { kind: "message", message: { role: "user", content: "queued" } },
      { holder: supervisor.holderId, flowId: "orphan" },
      external,
    )
    expect((yield* supervisor.status(id)).state).toBe("running")
    yield* TestClock.adjust("250 millis")
    expect(yield* supervisor.status(id)).toMatchObject({ state: "failed", reason: "execution_lost" })
    expect(yield* runs.queueLength(id)).toBe(1)
    expect(yield* runs.holderOf(id)).toBeNull()
  }).pipe(
    Effect.provide(
      Layer.merge(
        registryOf(project({ provider: new ScriptedProvider([]) })),
        Layer.provideMerge(supervisorLayer(), inMemory),
      ),
    ),
  ),
)

for (const mode of ["control poll", "local replacement", "local termination", "supervisor close"] as const)
  it.effect(`releases the outstanding callback on ${mode} before it returns`, () => {
    const entered = gate()
    const leave = gate()
    const wait = defineTool({
      description: "Wait without writing to the thread",
      execute: async () => {
        entered.release()
        await leave.opened
        return ok("late")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "wait", arguments: {} }] }, { text: "next run" }])
    const registry = registryOf(project({ provider, tools: { wait } }))
    return Effect.gen(function* () {
      const scope = yield* Scope.make()
      const service = yield* Layer.buildWithScope(supervisorLayer(), scope)
      yield* Effect.gen(function* () {
        const supervisor = yield* ThreadSupervisor
        const runs = yield* RunStore
        const { id } = yield* createThread("assistant")
        const sent = yield* Effect.forkChild(supervisor.send(id, "go"))
        yield* Effect.promise(() => entered.opened)
        if (mode === "control poll" || mode === "local replacement") {
          yield* runs.recoverThread(id, true)
          if (mode === "control poll") yield* TestClock.adjust("250 millis")
          else expect((yield* supervisor.send(id, "go again")).outcome?.reason).toBe("stop_on_response")
        } else {
          const settlement = yield* supervisor.abort(id)
          yield* TestClock.adjust("1 millis")
          expect(settlement?.isDone()).toBe(false)
          if (mode === "local termination") yield* Effect.forkChild(supervisor.control(id).terminate(external))
          else yield* Effect.forkChild(Scope.close(scope, Exit.void))
        }
        yield* TestClock.adjust("1 millis")
        expect(sent.pollUnsafe(), "the sender settled while the tool was still blocked").toBeDefined()
        const delivery = yield* Fiber.join(sent)
        expect(delivery.outcome?.reason).toBe(
          mode === "supervisor close" ? "aborted_by_user" : mode === "local termination" ? "aborted" : "execution_lost",
        )
      }).pipe(
        Effect.provideContext(service),
        Effect.ensuring(Effect.sync(leave.release)),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      )
    }).pipe(Effect.provide(Layer.merge(registry, inMemory)))
  })
