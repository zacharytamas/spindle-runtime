import { expect, it } from "@effect/vitest"
import { defineHook, defineTool, type ThreadState, type ToolResult } from "@standardagents/spec"
import { Clock, Duration, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { SqliteLive } from "#platform"
import { ScriptedProvider, type ScriptStep } from "../../../conformance/src/ScriptedProvider.ts"
import { gate, ok, project, type Setup } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage, stateAtRest } from "../../src/execution/trigger.ts"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { layer } from "../../src/store/sqlite.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf } from "../spindle-driver.ts"

const call = { id: "first", name: "wait", arguments: { q: "private words" } }
const limit = Duration.millis(10)
const timeout = "Tool wait timed out after 10ms"
const waitFor = (g: ReturnType<typeof gate>) => Effect.promise(() => g.opened)
const elapsed = TestClock.adjust(limit)
const messages = (id: string) =>
  MessageStore.use((store) => store.getMessages(id, { order: "asc", includeSilent: true }))

function waitingTool() {
  const entered = gate()
  const leave = gate()
  let state: ThreadState
  const tool = defineTool({
    description: "Wait for release",
    execute: async (handle: ThreadState) => {
      state = handle
      entered.release()
      await leave.opened
      return ok("returned")
    },
  })
  return { tool, entered, leave, state: () => state }
}

function fixture(
  tools: Setup["tools"],
  options: { steps?: ScriptStep[]; hooks?: Setup["hooks"]; limited?: boolean } = {},
) {
  const provider = new ScriptedProvider(options.steps ?? [{ toolCalls: [call] }, { text: "done" }])
  const registry = registryOf(
    project({ provider, tools, hooks: options.hooks, prompt: { hooks: options.hooks?.map((hook) => hook.id) ?? [] } }),
  )
  const settings = options.limited === false ? {} : { toolTimeout: () => limit }
  const stores = layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))
  const live = Layer.merge(registry, Layer.provideMerge(supervisorLayer(settings), stores))
  return { provider, live }
}

const start = Effect.gen(function* () {
  const { id } = yield* createThread("assistant")
  const sent = yield* Effect.forkChild(sendMessage(id, "go"))
  return { id, sent }
})

it.effect("stores one timeout error without arguments and pairs it with the call in the next request", () => {
  const wait = waitingTool()
  const { live, provider } = fixture({ wait: wait.tool })
  return Effect.gen(function* () {
    const { id, sent } = yield* start
    yield* waitFor(wait.entered)
    yield* elapsed
    wait.leave.release()
    yield* Fiber.join(sent)
    expect((yield* messages(id)).messages.filter((m) => m.role === "tool")).toMatchObject([
      { tool_call_id: call.id, tool_status: "error", content: timeout },
    ])
    expect(provider.requests[1]?.messages.slice(-2)).toMatchObject([
      { role: "assistant", toolCalls: [call] },
      { role: "tool", toolCallId: call.id, toolName: "wait", content: { type: "error", error: timeout } },
    ])
  }).pipe(Effect.provide(live))
})

it.effect("passes timeout errors through the failure, storage and done hooks and ordinary failure traces", () => {
  const wait = waitingTool()
  const events: unknown[] = []
  const hooks = [
    defineHook({
      hook: "tool_call_started",
      id: "start",
      execute: async (_state, call, progress) => {
        events.push(["start", call.id, progress])
      },
    }),
    defineHook({
      hook: "after_tool_call_failure",
      id: "failure",
      execute: async (_state, call, result) => {
        events.push(["failure", call, result])
        return { status: "error", error: "handled" }
      },
    }),
    defineHook({
      hook: "before_store_tool_result",
      id: "store",
      execute: async (_state, call, result) => {
        events.push(["store", call, result])
        return result
      },
    }),
    defineHook({
      hook: "tool_call_done",
      id: "done",
      execute: async (_state, call, result) => {
        events.push(["done", call, result])
      },
    }),
  ]
  const { live } = fixture({ wait: wait.tool }, { hooks })
  return Effect.gen(function* () {
    const { sent } = yield* start
    yield* waitFor(wait.entered)
    yield* elapsed
    wait.leave.release()
    const { outcome } = yield* Fiber.join(sent)
    const received = {
      id: call.id,
      type: "function",
      function: { name: "wait", arguments: JSON.stringify(call.arguments) },
    }
    const handled = { status: "error", error: "handled" }
    expect(events).toEqual([
      ["start", call.id, undefined],
      ["failure", received, { status: "error", error: timeout }],
      ["store", received, handled],
      ["done", received, handled],
    ])
    expect(outcome?.trace.filter((e) => e.step === 1 && ["tools", "persist-results"].includes(e.phase))).toEqual([
      { step: 1, phase: "tools", detail: "wait first" },
      { step: 1, phase: "persist-results", detail: "first error" },
    ])
  }).pipe(Effect.provide(live))
})

it.effect("starts each sibling deadline at execute after hooks and continues the run", () => {
  const first = waitingTool()
  const second = waitingTool()
  const hook = waitingTool()
  const hooks = [
    defineHook({
      hook: "tool_call_started",
      id: "gate",
      execute: async () => {
        hook.entered.release()
        await hook.leave.opened
      },
    }),
  ]
  const { live } = fixture(
    { wait: first.tool, sibling: second.tool },
    {
      hooks,
      steps: [{ toolCalls: [call, { ...call, id: "second", name: "sibling" }] }, { text: "done" }],
    },
  )
  return Effect.gen(function* () {
    const { id, sent } = yield* start
    yield* waitFor(hook.entered)
    yield* elapsed
    hook.leave.release()
    yield* waitFor(first.entered)
    yield* TestClock.adjust("9 millis")
    expect(yield* Effect.promise(() => first.state().getValue("still-live"))).toBeNull()
    yield* TestClock.adjust("1 millis")
    first.leave.release()
    yield* waitFor(second.entered)
    yield* TestClock.adjust("9 millis")
    second.leave.release()
    expect((yield* Fiber.join(sent)).outcome?.reason).toBe("stop_on_response")
    expect((yield* messages(id)).messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      timeout,
      "returned",
    ])
  }).pipe(Effect.provide(live))
})

for (const late of ["return", "reject"] as const)
  it.effect(
    `refuses writes from the expired handle and ignores a late ${late} without another hook, trace or result`,
    () => {
      const wait = waitingTool()
      const hooksSeen: string[] = []
      const hooks = [
        defineHook({
          hook: "tool_call_done",
          id: "done",
          execute: async (_state, c) => {
            hooksSeen.push(c.id)
          },
        }),
      ]
      const finished = gate()
      const tool = defineTool({
        description: "Settle late",
        execute: async (state: ThreadState) => {
          await wait.tool.execute(state)
          finished.release()
          if (late === "reject") throw new Error("late rejection")
          return ok("late success")
        },
      })
      const { live } = fixture({ wait: tool }, { hooks })
      return Effect.gen(function* () {
        const { id, sent } = yield* start
        yield* waitFor(wait.entered)
        yield* elapsed
        const snapshot = Effect.all(
          {
            thread: ThreadStore.use((s) => s.getThread(id)),
            messages: messages(id),
            queue: RunStore.use((s) => s.queueLength(id)),
            value: ThreadStore.use((s) => s.getValue(id, "late")),
          },
          { concurrency: 1 },
        )
        const before = yield* snapshot
        expect(before.thread.status.state).toBe("idle")
        const { outcome } = yield* Fiber.join(sent)
        const trace = structuredClone(outcome?.trace)
        const handle = wait.state()
        for (const write of [
          () => handle.injectMessage({ role: "user", content: "late" }),
          () => handle.queueMessage({ role: "user", content: "late" }),
          () => handle.setValue("late", true),
          () => handle.terminate(),
        ])
          yield* Effect.promise(() => expect(write()).rejects.toMatchObject({ _tag: "HandleExpired" }))
        wait.leave.release()
        yield* waitFor(finished)
        yield* Effect.yieldNow
        expect(yield* snapshot).toEqual(before)
        expect(outcome?.trace).toEqual(trace)
        expect(hooksSeen).toEqual([call.id])
      }).pipe(Effect.ensuring(Effect.sync(wait.leave.release)), Effect.provide(live))
    },
  )

for (const mode of ["stop", "abort", "terminate", "exit"] as const)
  it.effect(`releases the tool hold so ${mode} can settle with the tool still pending`, () => {
    const wait = waitingTool()
    const next = gate()
    const resume = gate()
    const { live } = fixture(
      { wait: wait.tool },
      {
        steps: [
          { toolCalls: [call] },
          async () => {
            next.release()
            await resume.opened
            return { text: "done" }
          },
        ],
      },
    )
    return Effect.gen(function* () {
      const { id, sent } = yield* start
      const supervisor = yield* ThreadSupervisor
      yield* waitFor(wait.entered)
      if (mode === "stop") yield* supervisor.stop(id)
      yield* elapsed
      expect((yield* messages(id)).messages.find((m) => m.role === "tool")?.content).toBe(timeout)
      if (mode !== "stop") {
        yield* waitFor(next)
        if (mode === "terminate") yield* supervisor.control(id).terminate({ kind: "external" })
        else yield* supervisor.abort(id, mode === "exit")
      }
      expect((yield* Fiber.join(sent)).status.state).toBe("idle")
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          wait.leave.release()
          resume.release()
        }),
      ),
      Effect.provide(live),
    )
  })

it.effect("keeps the deadline during an abort and delivers the waiting line only after it expires", () => {
  const wait = waitingTool()
  const { live, provider } = fixture({ wait: wait.tool })
  return Effect.gen(function* () {
    const { id, sent } = yield* start
    yield* waitFor(wait.entered)
    const supervisor = yield* ThreadSupervisor
    const settlement = yield* supervisor.abort(id)
    const queued = gate()
    const waiting = yield* Effect.forkChild(
      supervisor.send(id, "queued", { onWaiting: () => Effect.sync(queued.release) }),
    )
    yield* waitFor(queued)
    yield* TestClock.adjust("9 millis")
    expect(settlement?.isDone()).toBe(false)
    expect(provider.requests).toHaveLength(1)
    yield* TestClock.adjust("1 millis")
    expect(settlement?.isDone()).toBe(true)
    expect((yield* Fiber.join(sent)).outcome?.reason).toBe("aborted_by_user")
    expect((yield* Fiber.join(waiting)).status.reason).toBe("stop_on_response")
    expect(provider.requests[1]?.messages).toContainEqual({ role: "user", content: "queued" })
  }).pipe(Effect.ensuring(Effect.sync(wait.leave.release)), Effect.provide(live))
})

it.effect("applies the same deadline to a queued tool started by queueTool", () => {
  const wait = waitingTool()
  const { live, provider } = fixture({ wait: wait.tool }, { steps: [{ text: "done" }] })
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const state = yield* stateAtRest(id)
    state.queueTool("wait", {})
    yield* waitFor(wait.entered)
    yield* elapsed
    wait.leave.release()
    yield* (yield* ThreadSupervisor).settled(id)
    expect(provider.requests[0]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "wait",
      content: { type: "error", error: timeout },
    })
  }).pipe(Effect.provide(live))
})

it.effect("creates no tool timer without a limit and schedules one when a limit is set", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    for (const limited of [false, true]) {
      const sleeps: number[] = []
      const wait = waitingTool()
      const { live } = fixture({ wait: wait.tool }, { limited })
      yield* Effect.gen(function* () {
        const { id, sent } = yield* start
        yield* waitFor(wait.entered)
        yield* elapsed
        wait.leave.release()
        yield* Fiber.join(sent)
        expect((yield* messages(id)).messages.find((m) => m.role === "tool")?.content).toBe(
          limited ? timeout : "returned",
        )
        expect(sleeps.filter((ms) => ms !== 250)).toEqual(limited ? [10] : [])
      }).pipe(
        Effect.provide(live),
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) => {
            sleeps.push(Duration.toMillis(duration))
            return clock.sleep(duration)
          },
        }),
      )
    }
  }),
)

it.effect("leaves the execution abort signal live for a sibling after a tool times out", () => {
  const wait = waitingTool()
  const sibling = defineTool({
    description: "Inspect the signal",
    execute: async (state: ThreadState) =>
      ok(
        String(
          state.execution?.abortSignal === wait.state().execution?.abortSignal && !state.execution?.abortSignal.aborted,
        ),
      ),
  })
  const { live } = fixture(
    { wait: wait.tool, sibling },
    { steps: [{ toolCalls: [call, { ...call, id: "second", name: "sibling" }] }, { text: "done" }] },
  )
  return Effect.gen(function* () {
    const { id, sent } = yield* start
    yield* waitFor(wait.entered)
    yield* elapsed
    wait.leave.release()
    yield* Fiber.join(sent)
    expect((yield* messages(id)).messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      timeout,
      "true",
    ])
  }).pipe(Effect.provide(live))
})

it.effect("refuses a write at commit when its tool times out inside the message hook", () => {
  const entered = gate()
  const leave = gate()
  const hook = defineHook({
    id: "paused",
    hook: "before_create_message",
    execute: async (_state, message) => {
      if (message.content === "pending write") {
        entered.release()
        await leave.opened
      }
      return message
    },
  })
  let write: Promise<unknown>
  const wait = defineTool({
    description: "Inject a message through the paused hook",
    execute: async (state: ThreadState) => {
      write = state.injectMessage({ role: "user", content: "pending write" })
      await write
      return ok("wrote")
    },
  })
  const { live } = fixture(
    { wait },
    {
      hooks: [hook],
      steps: [
        { toolCalls: [call] },
        async () => {
          // Keep the flow active through the insert so only the tool's deadline can refuse it.
          await write.catch(() => {})
          return { text: "done" }
        },
      ],
    },
  )
  return Effect.gen(function* () {
    const { id, sent } = yield* start
    yield* waitFor(entered)
    yield* TestClock.adjust("11 millis")
    expect((yield* messages(id)).messages.find((m) => m.role === "tool")?.content).toBe(timeout)
    leave.release()
    yield* Effect.promise(() => expect(write).rejects.toMatchObject({ _tag: "HandleExpired" }))
    yield* Fiber.join(sent)
    expect((yield* messages(id)).messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["go"])
  }).pipe(Effect.ensuring(Effect.sync(leave.release)), Effect.provide(live))
})

it.effect("refuses a tool write past its deadline even before the event loop can run its timer", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    let millis = 0
    let refusal: unknown
    const wait = defineTool({
      description: "Advance past the deadline without yielding",
      execute: async (state: ThreadState) => {
        millis += 11
        try {
          await state.setValue("late", true)
        } catch (error) {
          refusal = error
        }
        return ok("late")
      },
    })
    const { live } = fixture({ wait })
    yield* Effect.gen(function* () {
      const { id, sent } = yield* start
      yield* Fiber.join(sent)
      expect(refusal).toMatchObject({ _tag: "HandleExpired" })
      expect(yield* ThreadStore.use((s) => s.getValue(id, "late"))).toBeNull()
      expect((yield* messages(id)).messages.find((m) => m.role === "tool")?.content).toBe(timeout)
    }).pipe(
      Effect.provide(live),
      Effect.provideService(Clock.Clock, {
        ...clock,
        currentTimeMillisUnsafe: () => millis,
        currentTimeMillis: Effect.sync(() => millis),
        monotonicTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
        monotonicTimeNanos: Effect.sync(() => BigInt(millis) * 1_000_000n),
      }),
    )
  }),
)

function nestedFixture(options: { awaitInner?: boolean; fail?: boolean } = {}) {
  const inner = waitingTool()
  const outer = defineTool({
    description: "Start the inner tool",
    execute: async (state: ThreadState) => {
      const pending = state.invokeTool("inner", {})
      if (options.awaitInner) await pending
      else void pending.catch(() => {}) // Aborting the flow interrupts invokeTool.
      return ok("outer returned")
    },
  })
  const steps: ScriptStep[] = [
    { toolCalls: [call] },
    options.fail ? { reject: { code: "invalid_request", message: "rejected" } } : { text: "done" },
    { text: "next reply" },
  ]
  return { inner, ...fixture({ wait: outer, inner: inner.tool }, { limited: false, steps }) }
}

it.effect("holds the running thread for an unawaited nested tool and continues queued work in the same flow", () => {
  const { inner, live, provider } = nestedFixture()
  return Effect.gen(function* () {
    const { id, sent } = yield* start
    const supervisor = yield* ThreadSupervisor
    yield* waitFor(inner.entered)
    yield* TestClock.adjust(0)
    expect((yield* supervisor.status(id)).state).toBe("running")
    expect(provider.requests).toHaveLength(2)
    yield* Effect.promise(() => inner.state().setValue("during-hold", true))
    expect(yield* ThreadStore.use((s) => s.getValue(id, "during-hold"))).toBe(true)
    const waiting = gate()
    const second = yield* Effect.forkChild(
      supervisor.send(id, "next", {
        onWaiting: (holder) =>
          Effect.sync(() => {
            expect(holder).toMatchObject({ kind: "local", operation: "tool inner" })
            waiting.release()
          }),
      }),
    )
    yield* waitFor(waiting)
    expect(yield* RunStore.use((s) => s.queueLength(id))).toBe(1)
    expect(provider.requests).toHaveLength(2)
    inner.leave.release()
    const first = yield* Fiber.join(sent)
    expect(first.outcome?.steps).toBe(3)
    expect((yield* Fiber.join(second)).outcome?.flowId).toBe(first.outcome?.flowId)
    expect(provider.requests).toHaveLength(3)
  }).pipe(Effect.ensuring(Effect.sync(inner.leave.release)), Effect.provide(live))
})

it.effect("a stop taken during the wait keeps the run's outcome and leaves queued work to its sender", () => {
  const { inner, live, provider } = nestedFixture()
  return Effect.gen(function* () {
    const { id, sent } = yield* start
    const supervisor = yield* ThreadSupervisor
    yield* waitFor(inner.entered)
    yield* TestClock.adjust(0)
    const waiting = gate()
    const second = yield* Effect.forkChild(
      supervisor.send(id, "next", { onWaiting: () => Effect.sync(() => waiting.release()) }),
    )
    yield* waitFor(waiting)
    expect(yield* supervisor.stop(id)).toBe(true)
    expect(provider.requests).toHaveLength(2)
    inner.leave.release()
    const first = yield* Fiber.join(sent)
    expect(first.outcome).toMatchObject({ steps: 2, status: "idle", reason: "stop_on_response" })
    // The stopped flow did not take the queued line. Its sender ran it in a flow of its own.
    expect((yield* Fiber.join(second)).outcome?.flowId).not.toBe(first.outcome?.flowId)
  }).pipe(Effect.ensuring(Effect.sync(inner.leave.release)), Effect.provide(live))
})

for (const fail of [false, true])
  it.effect(
    `keeps the ${fail ? "failure" : "successful outcome"} and history when a nested tool delays settlement`,
    () => {
      const snapshot = (hold: boolean) => {
        const { inner, live } = nestedFixture({ fail })
        return Effect.gen(function* () {
          if (!hold) inner.leave.release()
          const { id, sent } = yield* start
          const supervisor = yield* ThreadSupervisor
          yield* waitFor(inner.entered)
          yield* TestClock.adjust(0)
          if (hold) {
            expect((yield* supervisor.status(id)).state).toBe("running")
            expect(yield* supervisor.stop(id)).toBe(true)
            inner.leave.release()
          }
          const { outcome, status } = yield* Fiber.join(sent)
          const rows = (yield* messages(id)).messages
          expect(status.reason).toBe(fail ? "step_error" : "stop_on_response")
          expect(outcome?.steps).toBe(fail ? 1 : 2)
          if (fail) expect(outcome?.error).toMatchObject({ message: "rejected", code: "invalid_request" })
          return {
            ...outcome,
            threadId: undefined,
            flowId: undefined,
            trace: outcome?.trace.map(({ detail, ...entry }) => ({
              ...entry,
              detail: rows.reduce((text, row, i) => text.replaceAll(row.id, `message-${i}`), detail),
            })),
            messages: rows.map(({ id, created_at, ...row }) => row),
          }
        }).pipe(Effect.ensuring(Effect.sync(inner.leave.release)), Effect.provide(live))
      }
      return Effect.gen(function* () {
        const control = yield* snapshot(false)
        expect(yield* snapshot(true)).toEqual(control)
      })
    },
  )

it.effect("concurrent nested tools keep their own handles and deadlines past sibling and parent timeouts", () => {
  const short = waitingTool()
  const long = waitingTool()
  let shortResult: Promise<ToolResult>
  const parent = defineTool({
    description: "Start both children",
    execute: async (state: ThreadState) => {
      shortResult = state.invokeTool("short", {})
      await Promise.all([shortResult, state.invokeTool("long", {})])
      return ok("both finished")
    },
  })
  const { live } = fixture({ wait: parent, short: short.tool, long: long.tool })
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const supervisor = yield* ThreadSupervisor
    const limits = new Map([
      ["short", Duration.millis(5)],
      ["wait", limit],
      ["long", Duration.millis(20)],
    ])
    const sent = yield* Effect.forkChild(supervisor.send(id, "go", { toolTimeout: (name) => limits.get(name) }))
    yield* waitFor(short.entered)
    yield* waitFor(long.entered)
    yield* TestClock.adjust("4 millis")
    yield* Effect.promise(() => short.state().setValue("short", "live"))
    yield* TestClock.adjust("1 millis")
    expect(yield* Effect.promise(() => shortResult)).toEqual({
      status: "error",
      error: "Tool short timed out after 5ms",
    })
    yield* Effect.promise(() =>
      expect(short.state().setValue("short", "late")).rejects.toMatchObject({ _tag: "HandleExpired" }),
    )
    yield* Effect.promise(() => long.state().setValue("long", "sibling timed out"))
    yield* TestClock.adjust("5 millis")
    expect((yield* messages(id)).messages.find((m) => m.role === "tool")?.content).toBe(timeout)
    yield* TestClock.adjust("9 millis")
    yield* Effect.promise(() => long.state().setValue("long", "parent timed out"))
    yield* TestClock.adjust("1 millis")
    yield* Effect.promise(() =>
      expect(long.state().setValue("long", "late")).rejects.toMatchObject({ _tag: "HandleExpired" }),
    )
    expect((yield* Fiber.join(sent)).outcome?.reason).toBe("stop_on_response")
    expect(yield* ThreadStore.use((store) => store.getValue(id, "long"))).toBe("parent timed out")
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        short.leave.release()
        long.leave.release()
      }),
    ),
    Effect.provide(live),
  )
})

for (const deadline of ["general", "inner", "outer"] as const)
  it.effect(`uses each nested callback's own deadline with a ${deadline} limit`, () => {
    const { inner, live } = nestedFixture({ awaitInner: deadline === "outer" })
    return Effect.gen(function* () {
      const { id } = yield* createThread("assistant")
      const supervisor = yield* ThreadSupervisor
      const held: string[] = []
      const sent = yield* Effect.forkChild(
        supervisor.send(id, "go", {
          toolTimeout: (name) =>
            deadline === "general" || name === (deadline === "outer" ? "wait" : "inner") ? limit : undefined,
          onHold: (operation) =>
            Effect.sync(() => {
              held.push(operation)
            }),
        }),
      )
      yield* waitFor(inner.entered)
      yield* TestClock.adjust("9 millis")
      expect((yield* supervisor.status(id)).state).toBe("running")
      yield* TestClock.adjust("1 millis")
      if (deadline === "outer") {
        expect((yield* supervisor.status(id)).state).toBe("running")
        expect((yield* messages(id)).messages.find((m) => m.role === "tool")?.content).toBe(timeout)
        inner.leave.release()
      }
      expect((yield* Fiber.join(sent)).outcome?.reason).toBe("stop_on_response")
      expect(held).toEqual(["tool inner"])
    }).pipe(Effect.ensuring(Effect.sync(inner.leave.release)), Effect.provide(live))
  })

for (const abort of [false, true])
  it.effect(
    `a nested write's hook ${abort ? "keeps the abort hold until exit" : "expires at its default deadline"}`,
    () => {
      const entered = gate()
      const leave = gate()
      const hook = defineHook({
        id: "paused",
        hook: "before_create_message",
        execute: async (_state, message) => {
          if (message.content === "nested") {
            entered.release()
            await leave.opened
          }
          return message
        },
      })
      const wait = defineTool({
        description: "Start a write that runs a hook",
        execute: async (state: ThreadState) => {
          void state.injectMessage({ role: "user", content: "nested" }).catch(() => {})
          await entered.opened
          return ok("started")
        },
      })
      const { live } = fixture({ wait }, { hooks: [hook], limited: false })
      return Effect.gen(function* () {
        const supervisor = yield* ThreadSupervisor
        const { id } = yield* createThread("assistant")
        const held = Promise.withResolvers<string>()
        const sent = yield* Effect.forkChild(
          supervisor.send(id, "go", {
            onHold: (operation) => Effect.sync(() => held.resolve(operation)),
          }),
        )
        expect(yield* Effect.promise(() => held.promise)).toBe("hook paused")
        if (abort) yield* supervisor.abort(id)
        yield* TestClock.adjust("29999 millis")
        expect((yield* supervisor.status(id)).state).toBe("running")
        yield* TestClock.adjust("1 millis")
        if (abort) {
          expect((yield* supervisor.status(id)).state).toBe("running")
          yield* supervisor.abort(id, true)
        }
        expect((yield* Fiber.join(sent)).outcome?.reason).toBe(abort ? "aborted_by_user" : "stop_on_response")
      }).pipe(Effect.ensuring(Effect.sync(leave.release)), Effect.provide(live))
    },
  )

it.effect("aborting a failed step's wait signals the nested tool and holds until its callback returns", () => {
  const { inner, live } = nestedFixture({ fail: true })
  return Effect.gen(function* () {
    const { id, sent } = yield* start
    const supervisor = yield* ThreadSupervisor
    yield* waitFor(inner.entered)
    yield* TestClock.adjust(0)
    expect((yield* supervisor.status(id)).state).toBe("running")
    const settlement = yield* supervisor.abort(id)
    yield* TestClock.adjust(0)
    expect(inner.state().execution?.abortSignal.aborted).toBe(true)
    expect(settlement?.isDone()).toBe(false)
    inner.leave.release()
    expect((yield* Fiber.join(sent)).outcome).toMatchObject({
      status: "idle",
      reason: "aborted_by_user",
      steps: 1,
      trace: [],
      modelCalls: [],
    })
  }).pipe(Effect.ensuring(Effect.sync(inner.leave.release)), Effect.provide(live))
})
