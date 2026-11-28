import { defineAgent, defineHook, defineModel, definePrompt, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import type { RuntimeDriver } from "../../RuntimeDriver.ts"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { handlerOf } from "../handlers/fixtures.ts"
import { attempt, gate, history, ok, quiet, type Scenario, sideOf, waitForAdmission } from "../harness.ts"
import { gatedTool, promptAgent, raceGate, usingDirect, usingDirectPeer } from "./fixtures.ts"

const runValidationAndTermination = async (driver: RuntimeDriver) => {
  let savedToolHandle: ThreadState | undefined
  let expiredHookTag = ""
  const lateDone = gate()
  const helper = promptAgent("helper", new ScriptedProvider([{ text: "unused" }]))
  const tools = {
    capture: defineTool({
      description: "Capture handle and return",
      execute: async (state: ThreadState) => {
        savedToolHandle = state
        return ok("captured")
      },
    }),
  }
  const slowHook = defineHook({
    hook: "filter_messages",
    id: "slow_run_agent",
    execute: async (state, messages) => {
      await new Promise((resolve) => setTimeout(resolve, 180))
      expiredHookTag = await attempt(() => state.runAgent("helper"))
      lateDone.release()
      return messages
    },
  })
  await usingDirectPeer(
    driver,
    {
      provider: new ScriptedProvider([
        { toolCalls: [{ id: "c_cap", name: "capture", arguments: {} }] },
        { text: "primary reply" },
      ]),
      tools,
      hooks: [slowHook],
      models: [helper.model],
      prompts: [
        definePrompt({
          name: "assistant",
          toolDescription: "Primary",
          model: "scripted",
          prompt: "Primary.",
          tools: ["capture"],
          hooks: ["slow_run_agent"],
        }),
        helper.prompt,
      ],
      agents: [helper.agent],
    },
    async (session, thread, peer) => {
      const rest = await session.state(thread)
      expect(await attempt(() => rest.runAgent(""))).toBe("InvalidArguments")
      expect(await attempt(() => Reflect.apply(rest.runAgent, rest, [123]))).toBe("InvalidArguments")
      expect(await attempt(() => Reflect.apply(rest.runAgent, rest, [null]))).toBe("InvalidArguments")
      expect(await attempt(() => rest.runAgent("unknown_agent"))).toBe("SetupError")

      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response" })
      await lateDone.opened
      expect(expiredHookTag).toBe("HookExpired")
      expect(await attempt(() => savedToolHandle?.runAgent("helper"))).toMatch(/^(HandleExpired|ExecutionEnded)$/)

      // Rule 55: terminated thread rejects handles created before and after termination without queuing.
      const beforeTerm = await session.state(thread)
      await (await peer.state(thread)).terminate()
      const afterTerm = await peer.state(thread)
      const snapshot = await peer.inspect(thread)
      expect(await attempt(() => beforeTerm.runAgent("helper"))).toBe("ThreadTerminated")
      expect(await attempt(() => afterTerm.runAgent("helper"))).toBe("ThreadTerminated")
      expect(await peer.inspect(thread)).toEqual(snapshot)
      expect(snapshot.queue).toEqual([])
    },
    { hookTimeoutMs: 60 },
  )
}

const runAtRestAndPackedNamespace = async (driver: RuntimeDriver) => {
  const enteredFinalizer = gate()
  const releaseFinalizer = gate()
  const primaryProvider = new ScriptedProvider([{ text: "primary-1" }, { text: "primary-2" }])
  const finalizerProvider = new ScriptedProvider([
    async () => {
      enteredFinalizer.release()
      await releaseFinalizer.opened
      return { text: "finalizer-output" }
    },
  ])
  const sideBProvider = new ScriptedProvider([{ text: "side-b-output" }])
  const finalizer = promptAgent("finalizer", finalizerProvider, { includeChat: true })
  const sideBAgent = promptAgent("side_b_agent", sideBProvider, { includeChat: true, side: "b" })

  await usingDirectPeer(
    driver,
    {
      provider: primaryProvider,
      models: [finalizer.model, sideBAgent.model],
      prompts: [
        definePrompt({
          name: "assistant",
          toolDescription: "Primary",
          model: "scripted",
          prompt: "Primary.",
          includeChat: true,
        }),
        finalizer.prompt,
        sideBAgent.prompt,
      ],
      agents: [finalizer.agent, sideBAgent.agent],
    },
    async (session, thread, peer) => {
      expect(await session.send(thread, "hello")).toMatchObject({ status: "idle", reason: "stop_on_response" })
      const rest = await session.state(thread)

      // Rule 56: runAgent resolves Promise<void> immediately after commit without waiting for completion.
      let resolvedBeforeRelease = false
      const trigger = rest.runAgent("finalizer").then(() => {
        resolvedBeforeRelease = true
      })
      try {
        await trigger
        await enteredFinalizer.opened
        expect(resolvedBeforeRelease).toBe(true)
      } finally {
        releaseFinalizer.release()
      }
      expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      expect(history(finalizerProvider.requests[0]).map(sideOf)).toEqual([
        ["user", "hello"],
        ["assistant", "primary-1", []],
      ])
      expect((await session.messages(thread)).at(-1)).toMatchObject({
        role: "assistant",
        content: "finalizer-output",
        prompt: "finalizer_prompt",
      })
      // Rule 58: threads.agent_id stays unchanged.
      expect((await peer.state(thread)).agentId).toBe("assistant")

      // Rule 59: agent with sideA human and sideB prompt picks sideB as entry side.
      await rest.runAgent("side_b_agent")
      expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      expect((await session.messages(thread)).at(-1)).toMatchObject({
        role: "user",
        content: "side-b-output",
        prompt: "side_b_agent_prompt",
      })
      expect((await peer.state(thread)).agentId).toBe("assistant")

      // Subsequent send still runs primary agent, not finalizer or side_b_agent.
      expect(await session.send(thread, "follow-up")).toMatchObject({ status: "idle", reason: "stop_on_response" })
      expect((await session.messages(thread)).at(-1)).toMatchObject({
        role: "assistant",
        content: "primary-2",
        prompt: "assistant",
      })
    },
  )

  // Rule 54: packed entry agent resolves from global, internal agent rejects with SetupError from global.
  const packedProvider = new ScriptedProvider([{ text: "packed-entry-ran" }])
  const session = await driver.load({
    models: [defineModel({ name: "base_m", provider: new ScriptedProvider([]).factory, model: "base-v1" })],
    prompts: [definePrompt({ name: "base_p", toolDescription: "Base", model: "base_m", prompt: "Base." })],
    agents: [defineAgent({ name: "base", sideA: { prompt: "base_p" }, sideB: { human: true } })],
    packages: [
      {
        packageId: "pack_beta",
        entryAgents: ["pub"],
        models: [defineModel({ name: "pm", provider: packedProvider.factory, model: "pm-v1" })],
        prompts: [definePrompt({ name: "pp", toolDescription: "PP", model: "pm", prompt: "PP." })],
        agents: [
          defineAgent({ name: "pub", sideA: { prompt: "pp" }, sideB: { human: true } }),
          defineAgent({ name: "priv", sideA: { prompt: "pp" }, sideB: { human: true } }),
        ],
      },
    ],
  } as Parameters<RuntimeDriver["load"]>[0])
  try {
    const thread = await session.createThread("base")
    const rest = await session.state(thread)
    expect(await attempt(() => rest.runAgent("pack_beta/priv"))).toBe("SetupError")
    await rest.runAgent("pack_beta/pub")
    expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
    expect((await session.messages(thread)).at(-1)?.content).toBe("packed-entry-ran")
  } finally {
    await session.close()
  }
}

export const DE08: Scenario = {
  name: "DE08 (rules 54-56, 58, 59) runAgent validates inputs/handles/namespaces, rejects terminated threads, runs at rest over history, and leaves threads.agent_id unchanged",
  requirements: ["9090af10", "dc7d7df0"],
  run: async (driver) => {
    await runValidationAndTermination(driver)
    await runAtRestAndPackedNamespace(driver)
  },
}

export const DE09: Scenario = {
  name: "DE09 (rules 31, 57-59) runAgent while running appends durably without starting a concurrent flow, pauses prompt drain at agent entry, and runs in FIFO order",
  requirements: [],
  run: async (driver) => {
    // Part 1: Tool queues a message, then runAgent("one"), then runAgent("two") -> strict FIFO, pause before agent entry.
    const order: Array<string> = []
    const primaryProvider = new ScriptedProvider([
      { toolCalls: [{ id: "c_sched", name: "schedule_agents", arguments: {} }] },
      (req) => {
        order.push(`primary-step-2:${history(req).at(-1)?.content}`)
        return { text: "primary-done" }
      },
      () => {
        order.push("primary-next-send")
        return { text: "primary-again" }
      },
    ])
    const oneProvider = new ScriptedProvider([
      () => {
        order.push("agent-one")
        return { text: "one-done" }
      },
    ])
    const twoProvider = new ScriptedProvider([
      () => {
        order.push("agent-two")
        return { text: "two-done" }
      },
    ])
    const one = promptAgent("agent_one", oneProvider, { includeChat: true })
    const two = promptAgent("agent_two", twoProvider, { includeChat: true })
    const schedule_agents = defineTool({
      description: "Queue a user message and two runAgent triggers",
      execute: async (state: ThreadState) => {
        await state.queueMessage({ role: "user", content: "before-agents" })
        await state.runAgent("agent_one")
        await state.runAgent("agent_two")
        return ok("scheduled")
      },
    })
    await usingDirect(
      driver,
      {
        provider: primaryProvider,
        tools: { schedule_agents },
        models: [one.model, two.model],
        prompts: [
          definePrompt({
            name: "assistant",
            toolDescription: "Primary",
            model: "scripted",
            prompt: "Primary.",
            tools: ["schedule_agents"],
            includeChat: true,
          }),
          one.prompt,
          two.prompt,
        ],
        agents: [one.agent, two.agent],
      },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        expect(order).toEqual(["primary-step-2:before-agents", "agent-one", "agent-two"])
        expect((await session.state(thread)).agentId).toBe("assistant")
        expect(await session.send(thread, "next")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        expect(order.at(-1)).toBe("primary-next-send")
      },
    )

    // Part 2: External peer calls runAgent while primary run holds the thread -> queues without concurrent flow.
    const entered = gate()
    const release = gate()
    let inFlight = 0
    let overlapped = false
    const extOrder: Array<string> = []
    const hold = gatedTool(entered, release, () => {
      inFlight += 1
      extOrder.push("primary-tool-start")
    })
    const extPrimary = new ScriptedProvider([
      { toolCalls: [{ id: "c_hold", name: "hold", arguments: {} }] },
      () => {
        extOrder.push("primary-reply")
        inFlight -= 1
        return { text: "primary-finished" }
      },
    ])
    const extTargetProvider = new ScriptedProvider([
      () => {
        if (inFlight > 0) overlapped = true
        extOrder.push("target-ran")
        return { text: "target-finished" }
      },
    ])
    const extTarget = promptAgent("ext_target", extTargetProvider)
    await usingDirectPeer(
      driver,
      {
        provider: extPrimary,
        tools: { hold },
        models: [extTarget.model],
        prompts: [
          definePrompt({
            name: "assistant",
            toolDescription: "Primary",
            model: "scripted",
            prompt: "Primary.",
            tools: ["hold"],
          }),
          extTarget.prompt,
        ],
        agents: [extTarget.agent],
      },
      async (session, thread, peer) => {
        const running = quiet(session.send(thread, "go"))
        try {
          await raceGate(entered.opened, running, "primary hold tool")
          await (await peer.state(thread)).runAgent("ext_target")
          const mid = await peer.inspect(thread)
          expect(mid.status.state).toBe("running")
          expect(mid.queue.map((e) => e.kind)).toEqual(["agent"])
        } finally {
          release.release()
        }
        expect(await running).toMatchObject({ status: "idle", reason: "stop_on_response" })
        await waitForAdmission(async () => (await peer.inspect(thread)).queue.length === 0)
        expect(overlapped).toBe(false)
        expect(extOrder).toEqual(["primary-tool-start", "primary-reply", "target-ran"])
        expect((await peer.state(thread)).agentId).toBe("assistant")
      },
    )
  },
}

export const DE10: Scenario = {
  name: "DE10 (rule 59) runAgent targeting a handler-only agent settles handler_idle on empty queue and keeps the override active for a following queued message",
  requirements: [],
  run: async (driver) => {
    const receivedSingle: Array<string | null> = []
    const receivedDual: Array<string> = []
    const single_handler = handlerOf(async (state, message) => {
      receivedSingle.push(message.content)
      await state.setValue("handled_by", "single_handler")
    })
    const dual_a = handlerOf(async (state, message) => {
      receivedDual.push(`a:${message.content}`)
      await state.injectMessage({ role: "assistant", content: "from-dual-a" })
    })
    const dual_b = handlerOf(async (_state, message) => {
      receivedDual.push(`b:${message.content}`)
    })
    const entered = gate()
    const release = gate()
    const hold = gatedTool(entered, release)
    const primaryProvider = new ScriptedProvider([
      { toolCalls: [{ id: "c_h", name: "hold", arguments: {} }] },
      { text: "primary-after-hold" },
      { text: "primary-still-owner" },
    ])

    await usingDirectPeer(
      driver,
      {
        provider: primaryProvider,
        tools: { hold },
        handlers: { single_handler, dual_a, dual_b },
        agents: [
          defineAgent({ name: "handler_human", sideA: { handler: "single_handler" }, sideB: { human: true } }),
          defineAgent({ name: "handler_pair", sideA: { handler: "dual_a" }, sideB: { handler: "dual_b" } }),
        ],
      },
      async (session, thread, peer) => {
        const rest = await session.state(thread)

        // Part 1: Empty queue -> settles idle (handler_idle) without invoking handler.
        await rest.runAgent("handler_human")
        expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
        await rest.runAgent("handler_pair")
        expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
        expect(receivedSingle).toEqual([])
        expect(receivedDual).toEqual([])

        // Part 2: Queue runAgent(handler_human) + message, then runAgent(handler_pair) + message while thread is held.
        const running = quiet(session.send(thread, "start"))
        try {
          await raceGate(entered.opened, running, "hold before handler override")
          const pRest = await peer.state(thread)
          await pRest.runAgent("handler_human")
          await pRest.queueMessage({ role: "user", content: "for-single" })
          await pRest.runAgent("handler_pair")
          await pRest.queueMessage({ role: "user", content: "for-dual" })
        } finally {
          release.release()
        }
        await running
        await waitForAdmission(
          async () =>
            (await peer.inspect(thread)).status.state === "idle" && (await peer.inspect(thread)).queue.length === 0,
        )
        expect(receivedSingle).toEqual(["for-single"])
        expect(receivedDual).toEqual(["a:for-dual", "b:from-dual-a"])
        expect((await peer.inspect(thread)).values).toMatchObject({ handled_by: "single_handler" })
        expect((await peer.state(thread)).agentId).toBe("assistant")

        // Next send returns to primary agent.
        expect(await session.send(thread, "check-owner")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        expect((await session.messages(thread)).at(-1)?.content).toBe("primary-still-owner")
      },
    )
  },
}
