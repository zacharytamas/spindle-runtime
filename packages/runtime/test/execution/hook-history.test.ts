import { defineHook } from "@standardagents/spec"
import { expect, it } from "vitest"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { runTurn } from "../../../conformance/src/scenarios/harness.ts"
import { spindleDriver } from "../spindle-driver.ts"

it("dispatches the request when a hidden tool call has a malformed name", async () => {
  const provider = new ScriptedProvider([{ text: "done" }])
  const filter = defineHook({
    id: "hidden_call",
    hook: "filter_messages",
    execute: async (_state, messages) =>
      messages.map((message) => ({
        ...message,
        role: "user" as const,
        tool_calls: '[{"id":"hidden","function":{"na\\u006de":{"toString":0},"arguments":"{}"}}]',
      })),
  })
  const outcome = await runTurn(spindleDriver, { provider, hooks: [filter], prompt: { hooks: ["hidden_call"] } }, "go")
  expect(outcome?.reason).toBe("stop_on_response")
  expect(provider.requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "go" })
})

it("keeps shared call metadata shared inside a prefilter and isolates its failed edits from dispatch", async () => {
  const shared = { text: "original" }
  const filter = defineHook({
    hook: "filter_messages",
    id: "calls",
    execute: async (_state, messages) => [
      ...messages,
      ...["a", "b"].map((id) => ({
        id,
        role: "assistant" as const,
        content: null,
        created_at: 0,
        tool_calls: JSON.stringify([{ id, function: { name: "call", arguments: "{}" } }]),
        metadata: { tool_call_extra: { [id]: shared } },
      })),
    ],
  })
  const seen: string[] = []
  const edit = defineHook({
    hook: "prefilter_llm_history",
    id: "edit",
    execute: async (_state, messages) => {
      const calls = messages.flatMap((message) => (Array.isArray(message.tool_calls) ? message.tool_calls : []))
      calls[0].extra_content.text = "edited"
      seen.push(calls[1].extra_content.text)
      throw new Error("discard edits")
    },
  })
  const provider = new ScriptedProvider([{ text: "done" }])
  await runTurn(spindleDriver, { provider, hooks: [filter, edit], prompt: { hooks: ["calls", "edit"] } }, "go")
  expect(seen).toEqual(["edited"])
  expect(
    provider.requests[0]?.messages.flatMap((m) =>
      m.role === "assistant" ? (m.toolCalls?.map((c) => c.extraContent?.text) ?? []) : [],
    ),
  ).toEqual(["original", "original"])
})
