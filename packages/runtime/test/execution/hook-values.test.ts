import { defineHook, type Message } from "@standardagents/spec"
import { expect, it } from "vitest"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { stubTool, using } from "../../../conformance/src/scenarios/harness.ts"
import { spindleDriver } from "../spindle-driver.ts"

const nested = (depth: number) => {
  let value: Record<string, unknown> = {}
  for (let i = 0; i < depth; i++) value = { a: value }
  return value
}

it("a renamed caller with metadata too deep to compare does not end the run", async () => {
  const hook = defineHook({
    hook: "filter_messages",
    id: "deep",
    execute: async (_state, messages) =>
      (messages as Array<Message>).map((message) =>
        message.tool_calls ? { ...message, id: `${message.id}-renamed`, metadata: nested(15_000) } : message,
      ),
  })
  const provider = new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "first", arguments: {} }] }, { text: "done" }])
  await using(
    spindleDriver,
    { provider, tools: { first: stubTool("First", "one") }, hooks: [hook], prompt: { hooks: ["deep"] } },
    async (session, thread) => {
      const outcome = await session.send(thread, "go")
      expect(outcome.status).toBe("idle")
      expect(provider.requests).toHaveLength(2)
    },
  )
})
