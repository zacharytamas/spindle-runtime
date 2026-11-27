import { defineHook, defineTool, type LLMMessage, type Message, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../ScriptedProvider.ts"
import { callsOf, history, holding, ok, type Scenario, send, sideOf, using } from "./step-loop.ts"

const CANARY = "sk-canary-0042"

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
  {
    name: "I4 fails a create hook that picks an id with a control character, over 255 characters, or holding a secret",
    requirements: [],
    run: async (driver) => {
      const outcomes: Array<unknown> = []
      const idFor = async (state: ThreadState, content: string | null) => {
        switch (content) {
          case "nul":
            return "pre\u0000post"
          case "delete":
            return "pre\u007fpost"
          case "long":
            return "x".repeat(256)
          case "longest":
            return "y".repeat(255)
          case "secret":
          case "injected":
            return `row-${await state.instanceEnv?.("CANARY")}`
          default:
            return undefined
        }
      }
      const hooks = [
        defineHook({
          hook: "before_create_message",
          id: "pick_id",
          execute: async (state, message) => {
            const id = await idFor(state, message.content)
            return id === undefined ? message : { ...message, id }
          },
        }),
      ]
      const tools = {
        inject: defineTool({
          description: "Inject one message per kind of id",
          execute: async (state: ThreadState) => {
            for (const content of ["nul", "delete", "long", "secret", "longest"])
              outcomes.push(
                await state.injectMessage({ role: "user", content }).then(
                  async (message) => [content, (await state.getMessage(message.id))?.id === message.id],
                  (error: Error) => [content, error.message],
                ),
              )
            return ok("injected")
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "inject", arguments: {} }] },
        { text: "done" },
      ])
      await using(
        driver,
        { provider, tools, hooks, prompt: { hooks: ["pick_id"] } },
        async (session, thread) => {
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
          const stored = await session.messages(thread)
          expect(holding(stored, CANARY)).toEqual([])
          expect(stored.map((m) => m.id)).toContain("y".repeat(255))
          expect(rows(stored).filter(([role]) => role === "tool")).toEqual([["tool", "c1"]])
        },
        { CANARY },
      )
      const refused = (content: string) => [
        content,
        expect.stringContaining("Hook pick_id (before_create_message) returned a value that is not"),
      ]
      expect(outcomes).toEqual([
        refused("nul"),
        refused("delete"),
        refused("long"),
        [
          "secret",
          expect.stringContaining("Hook pick_id (before_create_message) returned an id that holds a secret value"),
        ],
        ["longest", true],
      ])
    },
  },
  {
    name: "I5 keeps only a tool result's own error_code and redacts a secret under error_code anywhere else",
    requirements: [],
    run: async (driver) => {
      const tools = {
        inject: defineTool({
          description: "Inject a message whose metadata nests a secret under error_code",
          execute: async (state: ThreadState) => {
            const secret = await state.instanceEnv?.("CANARY")
            await state.injectMessage({
              role: "user",
              content: "note",
              metadata: { error_code: { description: secret }, nested: { error_code: secret } },
            })
            return { status: "error" as const, error: "failed", error_code: "E_FAIL" }
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "inject", arguments: {} }] },
        { text: "done" },
      ])
      await using(
        driver,
        { provider, tools },
        async (session, thread) => {
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
          const stored = await session.messages(thread)
          expect(holding(stored, CANARY)).toEqual([])
          expect(stored.find((m) => m.content === "note")?.metadata).toEqual({
            error_code: { description: "[redacted]" },
            nested: { error_code: "[redacted]" },
          })
          expect(stored.find((m) => m.role === "tool")?.metadata).toMatchObject({ error_code: "E_FAIL" })
        },
        { CANARY },
      )
    },
  },
  {
    name: "I6 fails the run before the model call when a request hook adds a system message that holds a secret",
    requirements: [],
    run: async (driver) => {
      for (const position of ["filter_messages", "prefilter_llm_history"] as const) {
        const hooks = [
          position === "filter_messages"
            ? defineHook({
                hook: "filter_messages",
                id: "add_system",
                execute: async (state, messages) => [
                  ...messages,
                  {
                    id: "synthetic",
                    role: "system",
                    content: `key ${await state.instanceEnv?.("CANARY")}`,
                    created_at: 0,
                  },
                ],
              })
            : defineHook({
                hook: "prefilter_llm_history",
                id: "add_system",
                execute: async (state, messages) => [
                  ...messages,
                  { role: "system", content: `key ${await state.instanceEnv?.("CANARY")}` },
                ],
              }),
        ]
        const provider = new ScriptedProvider([{ text: "done" }])
        await using(
          driver,
          { provider, hooks, prompt: { hooks: ["add_system"] } },
          async (session, thread) => {
            const outcome = await send(session, thread, "go")
            expect(outcome).toMatchObject({ status: "failed", reason: "fatal_error", steps: 0 })
            expect(outcome.error?.message).toContain("holds a secret value")
            expect(holding(outcome, CANARY)).toEqual([])
          },
          { CANARY },
        )
        expect(provider.requests).toEqual([])
      }
    },
  },
  {
    name: "I7 counts a prefilter_llm_history return with a hole or a reasoning detail of no provider shape as a failed hook",
    requirements: [],
    run: async (driver) => {
      const returns: Array<(messages: Array<LLMMessage>) => Array<LLMMessage>> = [
        (messages) => {
          const holed = [...messages]
          holed.length += 1
          return holed
        },
        (messages) => {
          const parts: Array<unknown> = [{ type: "text", text: "a" }]
          parts.length += 1
          return [...messages, { role: "user", content: parts } as LLMMessage]
        },
        (messages) => [...messages, { role: "assistant", content: "ok", reasoning_details: [{ type: "bogus" }] }],
        (messages) => [
          ...messages,
          { role: "assistant", content: "ok", reasoning_details: [{ type: "reasoning.text", text: "native" }] },
        ],
        (messages) => [
          ...messages,
          { role: "assistant", content: "ok", reasoning_details: [{ type: "text", text: 1 }] },
        ],
        (messages) => [
          ...messages,
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "x1", type: "function", function: { name: "noop", arguments: { n: 1n } } }],
          } as LLMMessage,
        ],
      ]
      for (const give of returns) {
        const hooks = [
          defineHook({
            hook: "prefilter_llm_history",
            id: "odd_prefilter",
            execute: async (_s, messages) => give(messages),
          }),
        ]
        const provider = new ScriptedProvider([{ text: "done" }])
        await using(driver, { provider, hooks, prompt: { hooks: ["odd_prefilter"] } }, async (session, thread) => {
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 1 })
          expect(history(provider.requests[0]).map(sideOf)).toEqual([["user", "go"]])
          expect(session.logs().join("\n")).toContain("Hook odd_prefilter (prefilter_llm_history")
        })
      }
    },
  },
  {
    name: "I9 logs one line that names the hook and the limit when a nested write goes past the depth limit",
    requirements: [],
    run: async (driver) => {
      const hooks = [
        defineHook({
          hook: "before_create_message",
          id: "always_inject",
          execute: async (state, message) => {
            if (message.role === "user") await state.injectMessage({ role: "user", content: "again" })
            return message
          },
        }),
      ]
      const tools = {
        start: defineTool({
          description: "Inject the first message",
          execute: async (state: ThreadState) => {
            await state.injectMessage({ role: "user", content: "start" }).catch(() => undefined)
            return ok("started")
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "start", arguments: {} }] },
        { text: "done" },
      ])
      await using(driver, { provider, tools, hooks, prompt: { hooks: ["always_inject"] } }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const lines = session.logs().filter((line) => line.includes("limit of 8"))
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain("Hook always_inject (before_create_message)")
      })
    },
  },
  {
    name: "I10 sends a call's results right after its assistant message and a message stored between them after the results",
    requirements: [],
    run: async (driver) => {
      const tools = {
        note: defineTool({
          description: "Inject a note while the call runs",
          execute: async (state: ThreadState) => {
            await state.injectMessage({ role: "user", content: "note" })
            return ok("noted")
          },
        }),
        noop: defineTool({ description: "Does nothing", execute: async () => ok("noop") }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c1", name: "note", arguments: {} },
            { id: "c2", name: "noop", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        expect(rows(await session.messages(thread))).toEqual([
          ["user", "go"],
          ["assistant", null],
          ["user", "note"],
          ["tool", "c1"],
          ["tool", "c2"],
          ["assistant", "done"],
        ])
        expect(history(provider.requests[1]).map(sideOf)).toEqual([
          ["user", "go"],
          ["assistant", null, ["c1", "c2"]],
          ["tool", "c1"],
          ["tool", "c2"],
          ["user", "note"],
        ])
      })
      const call = (id: string) => ({ id, type: "function", function: { name: "noop", arguments: "{}" } })
      const seeded = new ScriptedProvider([{ text: "done" }])
      const past = { includeChat: true, includePastTools: true }
      await using(driver, { provider: seeded, tools, prompt: past }, async (session, thread) => {
        await session.seed(thread, [
          { role: "user", content: "q" },
          { role: "assistant", content: null, tool_calls: JSON.stringify([call("p1"), call("p2")]) },
          { role: "tool", tool_call_id: "p2", name: "noop", content: "two" },
          { role: "user", content: "between" },
          { role: "tool", tool_call_id: "p1", name: "noop", content: "one" },
        ])
        await send(session, thread, "go")
        expect(history(seeded.requests[0]).map(sideOf)).toEqual([
          ["user", "q"],
          ["assistant", null, ["p1", "p2"]],
          ["tool", "p1"],
          ["tool", "p2"],
          ["user", "between"],
          ["user", "go"],
        ])
      })
    },
  },
]
