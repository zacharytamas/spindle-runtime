import { defineHook, defineTool, type Message } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../ScriptedProvider.ts"
import { callsOf, history, ok, type Scenario, send, sideOf, using } from "./step-loop.ts"

const rows = (messages: ReadonlyArray<Message>) =>
  messages.map((m) => [m.role, m.role === "tool" ? m.tool_call_id : m.content])

export const integrityScenarios: ReadonlyArray<Scenario> = [
  {
    name: "I1 fails a before_create_message hook that changes an assistant message's tool calls and runs the calls the model returned",
    requirements: [],
    run: async (driver) => {
      const ran: Array<string> = []
      const hooks = [
        defineHook({
          hook: "before_create_message",
          id: "rename_calls",
          execute: async (_state, message) =>
            message.tool_calls == null ? message : { ...message, tool_calls: message.tool_calls.replace("c1", "c9") },
        }),
      ]
      const tools = {
        noop: defineTool({
          description: "Does nothing",
          execute: async () => {
            ran.push("noop")
            return ok("noop")
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
        { text: "done" },
      ])
      await using(driver, { provider, tools, hooks, prompt: { hooks: ["rename_calls"] } }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const stored = await session.messages(thread)
        expect(rows(stored)).toEqual([
          ["user", "go"],
          ["assistant", null],
          ["tool", "c1"],
          ["assistant", "done"],
        ])
        expect(callsOf(stored[1]).map((call) => call.id)).toEqual(["c1"])
        expect(history(provider.requests[1]).map(sideOf)).toEqual([
          ["user", "go"],
          ["assistant", null, ["c1"]],
          ["tool", "c1"],
        ])
        expect(session.logs().join("\n")).toContain("Hook rename_calls (before_create_message")
      })
      expect(ran).toEqual(["noop"])
    },
  },
  {
    name: "I2 stores a tool result once under a new id when a nested injection takes its id, and runs no hook twice",
    requirements: [],
    run: async (driver) => {
      let reserved = ""
      let calls = 0
      const hooks = [
        defineHook({
          hook: "before_create_message",
          id: "take_id",
          execute: async (state, message) => {
            calls += 1
            if (message.role === "tool") {
              reserved = message.id
              await state.injectMessage({ role: "user", content: "nested row" })
            }
            return message.content === "nested row" ? { ...message, id: reserved } : message
          },
        }),
      ]
      const tools = { noop: defineTool({ description: "Does nothing", execute: async () => ok("noop") }) }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
        { text: "done" },
      ])
      await using(driver, { provider, tools, hooks, prompt: { hooks: ["take_id"] } }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const stored = await session.messages(thread)
        expect(rows(stored)).toEqual([
          ["user", "go"],
          ["assistant", null],
          ["user", "nested row"],
          ["tool", "c1"],
          ["assistant", "done"],
        ])
        const result = stored[3]
        expect(stored[2]?.id).toBe(reserved)
        expect(result?.id).not.toBe(reserved)
        const lines = session.logs().filter((line) => line.includes(reserved))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain(result?.id)
        expect(history(provider.requests[1]).map(sideOf)).toContainEqual(["tool", "c1"])
      })
      expect(calls).toBe(4)
    },
  },
]
