import { expect, it } from "@effect/vitest"
import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { attempt, gate, ok, project, quiet, using } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage } from "../../src/execution/trigger.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf, spindleDriver } from "../spindle-driver.ts"
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

it.effect("refuses an inbound hook's write when recovery displaced its flow before the next poll", () => {
  const entered = gate()
  const release = gate()
  let result: string | undefined
  const hook = defineHook({
    id: "incoming",
    hook: "after_create_message",
    execute: async (state, message) => {
      if (message.content !== "go") return
      entered.release()
      await release.opened
      result = await attempt(() => state.setValue("stale", 1))
    },
  })
  const registry = registryOf(
    project({ provider: new ScriptedProvider([{ text: "done" }]), hooks: [hook], agent: { hooks: ["incoming"] } }),
  )
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const sent = yield* Effect.forkChild(sendMessage(id, "go"))
    yield* Effect.promise(() => entered.opened)
    yield* RunStore.use((store) => store.recoverThread(id, true))
    release.release()
    expect((yield* Fiber.join(sent)).outcome?.reason).toBe("execution_lost")
    expect(result).toBe("FlowEnded")
    expect(yield* ThreadStore.use((store) => store.getValue(id, "stale"))).toBeNull()
  }).pipe(
    Effect.ensuring(Effect.sync(release.release)),
    Effect.provide(Layer.merge(registry, Layer.provideMerge(supervisorLayer(), inMemory))),
  )
})

it("finishes inbound delivery on stop and runs the pending tool once on the next send", async () => {
  let ran = 0
  let kept: ThreadState | undefined
  const hook = defineHook({
    hook: "before_create_message",
    id: "stop_inbound",
    execute: async (state, message) => {
      if (message.content === "first") {
        kept = state
        state.queueTool("count", {})
        state.execution?.stop()
      }
      return message
    },
  })
  const count = defineTool({ description: "Count entries", execute: async () => ok(String(++ran)) })
  const provider = new ScriptedProvider([{ text: "done" }])
  await using(
    spindleDriver,
    { provider, tools: { count }, hooks: [hook], agent: { hooks: [hook.id] } },
    async (session, thread) => {
      expect(await session.send(thread, "first")).toMatchObject({ status: "idle", reason: "aborted", steps: 0 })
      expect((await session.messages(thread)).map((m) => m.content)).toEqual(["first"])
      expect((await session.inspect(thread)).queue.map((q) => q.kind)).toEqual(["tool"])
      expect(ran).toBe(0)
      expect(kept?.execution?.abortSignal.aborted).toBe(false)
      const staleWrite = () => attempt(() => kept?.injectMessage({ role: "user", content: "late" }))
      expect(await staleWrite()).toBe("HandleExpired")
      expect(await session.send(thread, "next")).toMatchObject({ status: "idle", steps: 1 })
      expect(ran).toBe(1)
      await (await session.state(thread)).terminate()
      expect(await staleWrite()).toMatch(/^(HandleExpired|ThreadTerminated)$/)
      expect((await session.messages(thread)).map((m) => m.content)).toEqual(["first", null, "1", "next", "done"])
    },
  )
})

it("holds the delivering flow until its inbound hook returns after an abort", async () => {
  const entered = gate()
  const aborted = gate()
  const leave = gate()
  const hook = defineHook({
    hook: "after_create_message",
    id: "observe_abort",
    execute: async (state, message) => {
      if (message.content !== "first" || !state.execution) return
      const { abortSignal } = state.execution
      abortSignal.addEventListener("abort", aborted.release, { once: true })
      entered.release()
      await leave.opened
    },
  })
  const provider = new ScriptedProvider([{ text: "done" }])
  await using(spindleDriver, { provider, hooks: [hook], agent: { hooks: [hook.id] } }, async (session, thread) => {
    const first = quiet(session.send(thread, "first"))
    await entered.opened
    const owner = (await session.inspect(thread)).claim
    try {
      expect(await session.abort(thread)).toBe(true)
      await aborted.opened
      await (await session.state(thread)).queueMessage({ role: "user", content: "next" })
      const held = await session.inspect(thread)
      expect(held.claim).toEqual(owner)
      expect(held.status.state).toBe("running")
      expect(held.queue).toHaveLength(1)
      expect(provider.requests).toHaveLength(0)
    } finally {
      leave.release()
    }
    await first
    await session.settled(thread)
    const stored = await session.inspect(thread)
    expect(stored.messages.map((m) => m.content)).toEqual(["first", "next", "done"])
    expect(stored.messages[0]?.flowId).toBe(owner?.flowId)
    expect(stored.messages[1]?.flowId).not.toBe(owner?.flowId)
    expect(stored.queue).toEqual([])
    expect(stored.claim).toBeNull()
  })
})
