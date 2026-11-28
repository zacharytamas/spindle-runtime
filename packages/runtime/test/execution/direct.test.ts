import { defineHook } from "@standardagents/spec"
import { expect, it } from "vitest"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { gatedTool, usingDirectPeer } from "../../../conformance/src/scenarios/direct-execution/fixtures.ts"
import { gate, waitForAdmission } from "../../../conformance/src/scenarios/harness.ts"
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
