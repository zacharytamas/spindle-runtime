import {
  defineHook,
  definePrompt,
  defineTool,
  type HandlerDefinition,
  type Message,
  type ThreadState,
} from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { attempt, gate, ok, quiet, type Scenario, statusOf, waitForAdmission } from "../harness.ts"
import { forceTool } from "../sides/fixtures.ts"
import { handlerOf, handlerProject, sendWith, usingHandler, usingHandlerPeer } from "./fixtures.ts"

export const HD04: Scenario = {
  name: "HD04 (rules 19, 20, §3) serializes queued messages without concurrent invocation and isolates a hung handler from other threads",
  requirements: ["0747a620", "ab2038a6", "dea03971", "2178d58c"],
  run: async (driver) => {
    // Part 1: queued messages wait in order while a handler turn is in flight.
    const enteredFirst = gate()
    const releaseFirst = gate()
    let inFlight = 0
    let overlapped = false
    const order: Array<string> = []
    const serial_handler = handlerOf(async (_state, message) => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      order.push(`start:${message.content}`)
      if (message.content === "m1") {
        enteredFirst.release()
        await releaseFirst.opened
      }
      order.push(`end:${message.content}`)
      inFlight -= 1
    })
    await usingHandlerPeer(
      driver,
      {
        sideA: { handler: "serial_handler" },
        sideB: { human: true },
        handlers: { serial_handler },
      },
      async (session, thread, peer) => {
        const running = quiet(sendWith(session, thread, "m1"))
        try {
          await Promise.race([
            enteredFirst.opened,
            quiet(
              running.then((outcome) => {
                throw new Error(`run settled before entering handler: ${outcome.status} (${outcome.reason})`)
              }),
            ),
          ])
          const peerState = await peer.state(thread)
          await peerState.queueMessage({ role: "user", content: "m2" })
          await peerState.queueMessage({ role: "user", content: "m3" })
          const mid = await peer.inspect(thread)
          expect(mid.status.state).toBe("running")
          expect(mid.queue.map((entry) => (JSON.parse(entry.payload) as { content?: string }).content)).toEqual([
            "m2",
            "m3",
          ])
          expect(order).toEqual(["start:m1"])
        } finally {
          releaseFirst.release()
        }
        const outcome = await running
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
        expect(overlapped).toBe(false)
        expect(order).toEqual(["start:m1", "end:m1", "start:m2", "end:m2", "start:m3", "end:m3"])
        expect((await session.inspect(thread)).queue).toEqual([])
        const stored = await session.messages(thread)
        expect(stored.map((m) => m.content)).toEqual(["m1", "m2", "m3"])
        expect(outcome.handlerCalls?.map((c) => c.messageId)).toEqual(stored.map((m) => m.id))
      },
    )

    // Part 2: a hung handler keeps its thread running while another thread proceeds; abort holds until return.
    const enteredHung = gate()
    const releaseHung = gate()
    let hungState: ThreadState | undefined
    const seenOther: Array<string> = []
    const maybe_hang = handlerOf(async (state, message) => {
      if (message.content === "hang") {
        hungState = state
        enteredHung.release()
        await releaseHung.opened
        return
      }
      seenOther.push(message.content ?? "")
    })
    const session = await driver.load(
      handlerProject({
        sideA: { handler: "maybe_hang" },
        sideB: { human: true },
        handlers: { maybe_hang },
      }),
    )
    try {
      const stalledThread = await session.createThread("relay")
      const otherThread = await session.createThread("relay")
      const stalledRun = quiet(sendWith(session, stalledThread, "hang"))
      await Promise.race([
        enteredHung.opened,
        quiet(
          stalledRun.then((outcome) => {
            throw new Error(`stalled run settled before entering handler: ${outcome.status} (${outcome.reason})`)
          }),
        ),
      ])
      const restStalled = await session.state(stalledThread)
      await restStalled.queueMessage({ role: "user", content: "waiting-behind-hang" })
      expect((await session.inspect(stalledThread)).status.state).toBe("running")
      expect((await session.inspect(stalledThread)).queue).toHaveLength(1)

      // Another thread runs to completion immediately while stalledThread stays running.
      const fast = await sendWith(session, otherThread, "fast-path")
      expect(fast).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
      expect(seenOther).toEqual(["fast-path"])
      expect((await session.inspect(stalledThread)).status.state).toBe("running")

      // Abort revokes the hung handler's handle and holds the claim until the handler returns.
      expect(await session.abort(stalledThread)).toBe(true)
      expect(await attempt(() => hungState?.setValue("late", "no"))).toBe("HandleExpired")
      expect((await session.inspect(stalledThread)).status.state).toBe("running")

      releaseHung.release()
      const aborted = await stalledRun
      expect(aborted).toMatchObject({ status: "idle", reason: "aborted_by_user", steps: 0 })
      // After abort cleanup, the queued message runs on the resumed follow-up run.
      await waitForAdmission(async () => (await session.inspect(stalledThread)).queue.length === 0)
      await session.settled(stalledThread)
      expect(seenOther).toEqual(["fast-path", "waiting-behind-hang"])
    } finally {
      releaseHung.release()
      await session.close()
    }
  },
}

export const HD05: Scenario = {
  name: "HD05 (rules 23, 24) delivers remaining peer messages before queued entries after a non-replying handler and never delivers at-rest injections",
  requirements: ["0747a620", "3df00a7e", "2178d58c"],
  run: async (driver) => {
    // Part 1 (rule 24): injectMessage at rest starts nothing and is never retroactively delivered.
    const deliveredAtRest: Array<string | null> = []
    const passive = handlerOf(async (_state, message) => {
      deliveredAtRest.push(message.content)
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "passive" },
        sideB: { human: true },
        handlers: { passive },
      },
      async (session, thread) => {
        const rest = await session.state(thread)
        await rest.injectMessage({ role: "user", content: "injected-at-rest" })
        expect(await statusOf(session, thread)).toMatchObject({ state: "idle", reason: null })
        expect(deliveredAtRest).toEqual([])
        const outcome = await sendWith(session, thread, "live-message")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
        expect(deliveredAtRest).toEqual(["live-message"])
      },
    )

    // Part 2 (rule 23): handler ignores first of two prompt messages -> still receives second, then queued entry.
    const seenB: Array<string | null> = []
    const ignoring_b = handlerOf(async (_state, message) => {
      seenB.push(message.content)
      // Returns cleanly without injecting in own role and without forceTurn.
    })
    const queue_for_b = defineTool({
      description: "Queue a message targeting side B during side A's turn",
      execute: async (state: ThreadState) => {
        await state.queueMessage({ role: "assistant", content: "queued-for-B" })
        return ok("queued")
      },
    })
    const providerA = new ScriptedProvider([
      { text: "A-first", toolCalls: [{ id: "c1", name: "queue_for_b", arguments: {} }] },
      { text: "A-second" },
    ])
    await usingHandler(
      driver,
      {
        sideA: { prompt: "worker" },
        sideB: { handler: "ignoring_b" },
        provider: providerA,
        prompts: [
          definePrompt({
            name: "worker",
            toolDescription: "Prompt A",
            model: "scripted",
            prompt: "You are A.",
            tools: ["queue_for_b"],
          }),
        ],
        tools: { queue_for_b },
        handlers: { ignoring_b },
      },
      async (session, thread) => {
        const outcome = await sendWith(session, thread, "start")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 2 })
        // Peer side's remaining messages come first in seq order, then queued entries.
        expect(seenB).toEqual(["A-first", "A-second", "queued-for-B"])
        expect(providerA.requests).toHaveLength(2)
      },
    )
  },
}

export const HD06: Scenario = {
  name: "HD06 (rules 14, 16, 17) forceTurn targeting a handler delivers the next undelivered message or settles handler_idle without fabricating or redelivering",
  requirements: ["0747a620", "0b7bee20", "1a0354bc"],
  run: async (driver) => {
    // Part 1: prompt A calls forceTurn("b") -> handler B receives A's undelivered assistant message once.
    const seenFromPrompt: Array<string | null> = []
    const target_b = handlerOf(async (_state, message) => {
      seenFromPrompt.push(message.content)
    })
    const providerA = new ScriptedProvider([
      { text: "handed off", toolCalls: [{ id: "f1", name: "force_b", arguments: {} }] },
    ])
    await usingHandler(
      driver,
      {
        sideA: { prompt: "worker", stopOnResponse: false },
        sideB: { handler: "target_b" },
        provider: providerA,
        prompts: [
          definePrompt({
            name: "worker",
            toolDescription: "Prompt A",
            model: "scripted",
            prompt: "You are A.",
            tools: ["force_b"],
          }),
        ],
        tools: { force_b: forceTool("b") },
        handlers: { target_b },
      },
      async (session, thread) => {
        const outcome = await sendWith(session, thread, "go")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 1 })
        expect(seenFromPrompt).toEqual(["handed off"])
      },
    )

    // Part 2: handler calls forceTurn targeting a handler side with NO undelivered message -> settles handler_idle,
    // never fabricates a message and never redelivers a prior message.
    const callsA: Array<string | null> = []
    const callsB: Array<string | null> = []
    const force_empty_b = handlerOf(async (state, message) => {
      callsA.push(message.content)
      state.execution?.forceTurn("b")
    })
    const never_called_b = handlerOf(async (_state, message) => {
      callsB.push(message.content)
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "force_empty_b" },
        sideB: { handler: "never_called_b" },
        handlers: { force_empty_b, never_called_b },
      },
      async (session, thread) => {
        const outcome = await sendWith(session, thread, "only-for-a")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
        expect(callsA).toEqual(["only-for-a"])
        expect(callsB).toEqual([])
        expect((await session.messages(thread)).map((m) => [m.role, m.content])).toEqual([["user", "only-for-a"]])
      },
    )

    // Self-forcing a handler with an empty queue never redelivers the current message.
    const selfCalls: Array<string | null> = []
    const force_self = handlerOf(async (state, message) => {
      selfCalls.push(message.content)
      state.execution?.forceTurn("a")
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "force_self" },
        sideB: { human: true },
        handlers: { force_self },
      },
      async (session, thread) => {
        const outcome = await sendWith(session, thread, "once-only")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
        expect(selfCalls).toEqual(["once-only"])
      },
    )

    // Part 3: handler calls forceTurn targeting an opposite prompt side without injecting -> prompt still runs.
    const providerB = new ScriptedProvider([{ text: "prompt B ran" }])
    const seenPromptReply: Array<string | null> = []
    const kick_prompt = handlerOf(async (state, message) => {
      seenPromptReply.push(message.content)
      if (message.content === "trigger") state.execution?.forceTurn("b")
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "kick_prompt" },
        sideB: { prompt: "reviewer" },
        provider: providerB,
        prompts: [
          definePrompt({
            name: "reviewer",
            toolDescription: "Prompt B",
            model: "scripted",
            prompt: "You are B.",
            includeChat: true,
          }),
        ],
        handlers: { kick_prompt },
      },
      async (session, thread) => {
        const outcome = await sendWith(session, thread, "trigger")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 1 })
        expect(providerB.requests).toHaveLength(1)
        expect(seenPromptReply).toEqual(["trigger", "prompt B ran"])
      },
    )
  },
}

export const HD07: Scenario = {
  name: "HD07 (rules 6, 7, 25, §1.5, §3) ignores handler return values, isolates mutated messages, expires handles, exposes ThreadState capabilities, and shares context",
  requirements: ["ea88514a", "6ce44191", "295e5c90", "2ea40632", "c487ef3f"],
  run: async (driver) => {
    // Part 1: Return values of wrong shapes are ignored without reading properties on them.
    let propRead = false
    const boobyTrapped = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        propRead = true
        throw new Error("should not read return value")
      },
    })
    const returnValues: Array<unknown> = ["a string", { reply: "not sent" }, 42, boobyTrapped]
    const rawSyncHandler = {
      [Symbol.for("standardagents.handler")]: true,
      description: "Returns non-void values synchronously and asynchronously",
      execute: (_state: ThreadState, _message: Message) => {
        const next = returnValues.shift()
        return next === 42 ? next : Promise.resolve(next)
      },
    } as unknown as HandlerDefinition
    await usingHandler(
      driver,
      {
        sideA: { handler: "odd_returns" },
        sideB: { human: true },
        handlers: { odd_returns: rawSyncHandler },
      },
      async (session, thread) => {
        for (const label of ["r1", "r2", "r3", "r4"]) {
          const out = await sendWith(session, thread, label)
          expect(out).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
        }
        expect(propRead).toBe(false)
        // Zero auto-reply messages were created from any return value.
        expect((await session.messages(thread)).map((m) => [m.role, m.content])).toEqual([
          ["user", "r1"],
          ["user", "r2"],
          ["user", "r3"],
          ["user", "r4"],
        ])
      },
    )

    // Part 2: Message mutation isolation, expired handle rejection, ThreadState capabilities (env, KV, invokeTool,
    // queueMessage), and shared mutable context across delivery hooks, handler, nested tool, and opposite prompt.
    let savedState: ThreadState | undefined
    const contextRefs: Array<Record<string, unknown>> = []
    const trail: Array<string> = []
    let toolResultSeen: unknown
    let envSeen: string | undefined
    let kvSeen: unknown
    let historyBeforeMutate: string | null | undefined
    let historyAfterMutate: string | null | undefined

    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "ctx_before",
        execute: async (state, message) => {
          if (message.role === "user" && message.content === "run 1") {
            contextRefs.push(state.context)
            state.context.fromDelivery = "yes"
            trail.push("hook:before")
          }
          return message
        },
      }),
    ]
    const helper = defineTool({
      description: "Nested helper invoked by a handler",
      execute: async (state: ThreadState) => {
        contextRefs.push(state.context)
        state.context.fromTool = "yes"
        trail.push(`tool:${state.execution?.currentSide}:${state.execution?.promptPath.join(",")}`)
        return ok(`env=${await state.env("AGENT_SECRET_HINT")}`)
      },
    })
    const capable_handler = handlerOf(async (state, message) => {
      if (message.content === "run 1") {
        savedState = state
        contextRefs.push(state.context)
        trail.push(`handler:delivery=${String(state.context.fromDelivery)}`)
        // Mutate the received message argument aggressively.
        historyBeforeMutate = state.execution?.messageHistory.find((m) => m.id === message.id)?.content
        ;(message as { content: string | null }).content = "CORRUPTED"
        ;(message as { role: string }).role = "system"
        if (message.metadata) message.metadata.tampered = true
        historyAfterMutate = state.execution?.messageHistory.find((m) => m.id === message.id)?.content

        envSeen = await state.env("AGENT_SECRET_HINT")
        await state.setValue("handler_key", { ok: true })
        kvSeen = await state.getValue("handler_key")
        toolResultSeen = await state.invokeTool("helper", {})
        trail.push(`handler:afterTool=${String(state.context.fromTool)}`)
        await state.queueMessage({ role: "user", content: "self-queued" })
        // Inject in own role to verify opposite prompt sees shared context too.
        await state.injectMessage({ role: "assistant", content: "to prompt B" })
      } else if (message.content === "self-queued") {
        // The first handler turn's state handle must already be expired even while the same execution is still running.
        trail.push(`handler:self-queued:prev=${await attempt(() => savedState?.setValue("mid-run-late", "x"))}`)
        trail.push(`handler:self-queued:tool=${String(state.context.fromTool)}`)
      } else if (message.content === "run 2") {
        trail.push(`handler:run2:keys=${Object.keys(state.context).join(",")}`)
      }
    })
    const providerB = new ScriptedProvider([{ text: "B saw it" }])
    const check_b_ctx = defineHook({
      hook: "filter_messages",
      id: "check_b_ctx",
      execute: async (state, messages) => {
        contextRefs.push(state.context)
        trail.push(`promptB:tool=${String(state.context.fromTool)}`)
        return messages
      },
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "capable_handler" },
        sideB: { prompt: "reviewer" },
        provider: providerB,
        prompts: [
          definePrompt({
            name: "reviewer",
            toolDescription: "Prompt B",
            model: "scripted",
            prompt: "You are B.",
            hooks: ["check_b_ctx"],
          }),
        ],
        tools: { helper },
        hooks: [...hooks, check_b_ctx],
        handlers: { capable_handler },
        agent: { hooks: ["ctx_before"], env: { AGENT_SECRET_HINT: "agent-val" } },
      },
      async (session, thread) => {
        const out1 = await sendWith(session, thread, "run 1")
        expect(out1).toMatchObject({ status: "idle", reason: "handler_idle", steps: 1 })
        // Stored copy and history cache are untouched by handler's mutation of `message`.
        const stored = await session.messages(thread)
        expect(stored[0]).toMatchObject({ role: "user", content: "run 1" })
        expect(stored[0]?.metadata).not.toHaveProperty("tampered")
        expect([historyBeforeMutate, historyAfterMutate]).toEqual(["run 1", "run 1"])
        // invokeTool ran nested without storing synthetic tool_calls or role: tool messages.
        expect(stored.filter((m) => m.role === "tool")).toEqual([])
        expect(toolResultSeen).toEqual({ status: "success", result: "env=agent-val" })
        expect(envSeen).toBe("agent-val")
        expect(kvSeen).toEqual({ ok: true })
        expect(await (await session.state(thread)).getValue("handler_key")).toEqual({ ok: true })
        // Same context object shared across delivery hook, handler, nested tool, and prompt B.
        expect(contextRefs.length).toBeGreaterThanOrEqual(4)
        expect(contextRefs.every((ref) => ref === contextRefs[0])).toBe(true)
        expect(trail).toEqual([
          "hook:before",
          "handler:delivery=yes",
          "tool:a:",
          "handler:afterTool=yes",
          "promptB:tool=yes",
          "handler:self-queued:prev=HandleExpired",
          "handler:self-queued:tool=yes",
        ])
        // Retained handle after return rejects writes with HandleExpired.
        expect(await attempt(() => savedState?.setValue("late", "x"))).toBe("HandleExpired")
        expect(await attempt(() => savedState?.injectMessage({ role: "assistant", content: "late" }))).toBe(
          "HandleExpired",
        )
        expect(await attempt(() => savedState?.queueMessage({ role: "user", content: "late" }))).toBe("HandleExpired")
        expect(await attempt(() => savedState?.stopSession())).toBe("HandleExpired")
        expect(await attempt(() => savedState?.queueTool("helper", {}))).toBe("HandleExpired")

        // Next run gets a fresh empty context and arguments stay untouched.
        const rest = await session.state(thread)
        expect([rest.context, rest.arguments]).toEqual([{}, {}])
        await sendWith(session, thread, "run 2")
        expect(trail.at(-1)).toBe("handler:run2:keys=")
      },
    )
  },
}
