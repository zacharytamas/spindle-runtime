import { expect, it } from "@effect/vitest"
import { defineHook } from "@standardagents/spec"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { attempt, gate, project } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage } from "../../src/execution/trigger.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf } from "../spindle-driver.ts"
import { inMemory } from "../store/contract-fixtures.ts"

it.effect("refuses a write submitted by a hook before its timeout that reaches SQLite after settlement", () => {
  const entered = gate()
  const release = gate()
  let submitted: Promise<string> | undefined
  const hold = defineHook({
    hook: "filter_messages",
    id: "write",
    execute: async (state, messages) => {
      submitted = attempt(() => state.setValue("late", true))
      await release.opened
      return messages
    },
  })
  const stores = Layer.effect(
    ThreadStore,
    ThreadStore.use((store) =>
      Effect.succeed({
        ...store,
        setValue: (...args: Parameters<typeof store.setValue>) =>
          Effect.gen(function* () {
            entered.release()
            yield* Effect.promise(() => release.opened)
            return yield* store.setValue(...args)
          }),
      }),
    ),
  ).pipe(Layer.provideMerge(inMemory))
  const registry = registryOf(
    project({ provider: new ScriptedProvider([{ text: "done" }]), hooks: [hold], prompt: { hooks: ["write"] } }),
  )
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const sent = yield* Effect.forkChild(sendMessage(id, "go"))
    yield* Effect.promise(() => entered.opened)
    yield* TestClock.adjust("30 seconds")
    expect((yield* Fiber.join(sent)).status).toMatchObject({ state: "idle", reason: "stop_on_response" })
    release.release()
    expect(yield* Effect.promise(async () => submitted)).toMatch(/^(FlowEnded|HandleExpired)$/)
    expect(yield* ThreadStore.use((store) => store.getValue(id, "late"))).toBeNull()
  }).pipe(
    Effect.ensuring(Effect.sync(release.release)),
    Effect.provide(Layer.merge(registry, Layer.provideMerge(supervisorLayer(), stores))),
  )
})
