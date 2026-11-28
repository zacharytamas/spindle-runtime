import {
  defineAgent,
  defineHandler,
  defineHook,
  definePrompt,
  defineTool,
  type ThreadState,
} from "@standardagents/spec"
import { expect, it } from "vitest"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import {
  gatedTool,
  promptAgent,
  usingDirectPeer,
} from "../../../conformance/src/scenarios/direct-execution/fixtures.ts"
import { gate, ok, waitForAdmission } from "../../../conformance/src/scenarios/harness.ts"
import { spindleDriver } from "../spindle-driver.ts"

it("a send admitted during a direct tool waits for the execution that delivers it", async () => {
  const entered = gate()
  const release = gate()
  const delivery = gate()
  const finish = gate()
  const wait = defineHook({
    id: "wait_for_delivery",
    hook: "before_create_message",
    execute: async (_state, message) => {
      if (message.role === "user") {
        delivery.release()
        await finish.opened
      }
      return message
    },
  })
  const provider = new ScriptedProvider([{ text: "delivered" }])
  await usingDirectPeer(
    spindleDriver,
    { provider, hooks: [wait], agent: { hooks: ["wait_for_delivery"] }, tools: { hold: gatedTool(entered, release) } },
    async (owner, thread, peer) => {
      const direct = (await owner.state(thread)).invokeTool("hold", {})
      await entered.opened
      const send = owner.send(thread, "while held")
      try {
        await waitForAdmission(async () => (await peer.inspect(thread)).queue.length === 1)
      } finally {
        release.release()
      }
      try {
        expect(await direct).toMatchObject({ status: "success" })
        await delivery.opened
      } finally {
        finish.release()
      }
      expect(await send).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      expect((await peer.messages(thread)).map((message) => message.content)).toEqual(["while held", "delivered"])
    },
  )
})

it("rule 47: direct invokeTool at rest learns secrets declared on the thread's agent", async () => {
  const secretValue = "agent-secret-token-987654"
  let queueError: unknown
  const leaker = defineTool({
    description: "Writes an agent secret without declaring it",
    execute: async (state: ThreadState) => {
      await state.injectMessage({ role: "assistant", content: `leak=${secretValue}` })
      try {
        await state.queueTool("leaker", { token: secretValue })
      } catch (error) {
        queueError = error
      }
      return ok("done")
    },
  })
  const provider = new ScriptedProvider([])
  await usingDirectPeer(
    spindleDriver,
    {
      provider,
      agent: { env: { AGENT_SECRET: secretValue } },
      prompt: {
        env: { PROMPT_SECRET: secretValue },
        variables: [{ name: "PROMPT_SECRET", type: "secret", required: false, description: "Agent prompt secret" }],
      },
      tools: { leaker },
    },
    async (owner, thread, peer) => {
      const rest = await owner.state(thread)
      expect(await rest.invokeTool("leaker", {})).toMatchObject({ status: "success", result: "done" })
      expect((await peer.messages(thread)).map((message) => message.content)).toEqual(["leak=[redacted]"])
      expect(queueError).toMatchObject({ _tag: "SecretInArguments" })
    },
  )
})

it("at-rest before_create_message hook and direct invokeTool share learned secrets in both directions", async () => {
  const secretValue = "hook-shared-secret-112233"
  const reader = defineTool({
    description: "Reads a secret through state.env and returns it",
    execute: async (state: ThreadState) => ok(`found=${(await state.env("SHARED_SECRET")) ?? ""}`),
  })
  const hook = defineHook({
    id: "redact_via_tool",
    hook: "before_create_message",
    execute: async (state, message) => {
      const res = await state.invokeTool("reader", {})
      return { ...message, content: `${message.content}:${res.status === "success" ? res.result : ""}` }
    },
  })
  await usingDirectPeer(
    spindleDriver,
    {
      provider: new ScriptedProvider([]),
      agent: { env: { SHARED_SECRET: secretValue }, hooks: ["redact_via_tool"] },
      hooks: [hook],
      tools: { reader },
    },
    async (owner, thread, peer) => {
      const rest = await owner.state(thread)
      await rest.injectMessage({ role: "user", content: "hi" })
      expect((await peer.messages(thread)).map((message) => message.content)).toEqual(["hi:found=[redacted]"])
    },
  )
})

it("a tool queued with side a after runAgent drains on a helper whose side a is human", async () => {
  const ran: Array<string> = []
  const switchAndQueue = defineTool({
    description: "Queues runAgent then queueTool from side A",
    execute: async (state: ThreadState) => {
      await state.runAgent("helper")
      await state.queueTool("echo", {})
      return ok("queued")
    },
  })
  const echo = defineTool({
    description: "Records execution",
    execute: async () => {
      ran.push("after-switch")
      return ok("echo:after-switch")
    },
  })
  const mainProvider = new ScriptedProvider([
    { toolCalls: [{ id: "c1", name: "switch_and_queue", arguments: {} }] },
    { text: "alpha done" },
  ])
  const helper = promptAgent("helper", new ScriptedProvider([{ text: "helper done" }]), {
    side: "b",
    tools: ["echo"],
  })
  await usingDirectPeer(
    spindleDriver,
    {
      provider: mainProvider,
      tools: { switch_and_queue: switchAndQueue, echo },
      prompts: [
        definePrompt({
          name: "assistant",
          toolDescription: "Main prompt",
          model: "scripted",
          prompt: "Main prompt.",
          tools: ["switch_and_queue", "echo"],
        }),
        helper.prompt,
      ],
      models: [helper.model],
      agents: [helper.agent],
    },
    async (owner, thread, peer) => {
      const outcome = await owner.send(thread, "go")
      expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response" })
      expect(ran).toEqual(["after-switch"])
      expect((await peer.inspect(thread)).queue).toEqual([])
      expect((await peer.messages(thread)).at(-1)?.content).toBe("helper done")
    },
  )
})

it("delivers all buffered handler messages before switching to a queued runAgent", async () => {
  const seenByOriginal: Array<string> = []
  const seenByHelper: Array<string> = []
  const emitExtra = defineTool({
    description: "Injects an assistant message so the handler receives two buffered messages",
    execute: async (state: ThreadState) => {
      await state.injectMessage({ role: "assistant", content: "buffered-1" })
      return ok("injected")
    },
  })
  const originalHandler = defineHandler({
    execute: async (state, message) => {
      const text = message.content ?? ""
      seenByOriginal.push(text)
      if (text === "buffered-1") {
        await state.runAgent("helper")
        await state.injectMessage({ role: "user", content: "handler-reply-1" })
      }
    },
  })
  const helperHandler = defineHandler({
    execute: async (_state, message) => {
      seenByHelper.push(message.content ?? "")
    },
  })
  const mainProvider = new ScriptedProvider([
    { text: "calling-tool", toolCalls: [{ id: "c1", name: "emit_extra", arguments: {} }] },
    { text: "buffered-2" },
  ])
  const helper = promptAgent("helper", new ScriptedProvider([{ text: "helper-reply" }]))
  const helperAgent = defineAgent({
    name: "helper",
    sideA: { prompt: helper.prompt.name },
    sideB: { handler: "helper_handler" },
  })
  await usingDirectPeer(
    spindleDriver,
    {
      provider: mainProvider,
      tools: { emit_extra: emitExtra },
      sideB: { handler: "orig_handler" },
      prompts: [
        definePrompt({
          name: "assistant",
          toolDescription: "Main prompt",
          model: "scripted",
          prompt: "Main prompt.",
          tools: ["emit_extra"],
        }),
        helper.prompt,
      ],
      models: [helper.model],
      handlers: { orig_handler: originalHandler, helper_handler: helperHandler },
      agents: [helperAgent],
    },
    async (owner, thread, peer) => {
      const outcome = await owner.send(thread, "start")
      expect(outcome).toMatchObject({ status: "idle" })
      expect(seenByOriginal).toEqual(["calling-tool", "buffered-1", "buffered-2"])
      expect(seenByHelper).toEqual(["helper-reply"])
      expect((await peer.inspect(thread)).queue).toEqual([])
    },
  )
})
