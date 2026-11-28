import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect, it } from "vitest"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { gatedTool, usingDirectPeer } from "../../../conformance/src/scenarios/direct-execution/fixtures.ts"
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
