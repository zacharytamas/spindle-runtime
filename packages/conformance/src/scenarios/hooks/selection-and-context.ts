import { defineHook, defineTool, type HookExecutionContext, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, ok, runTurn, type Scenario, type Setup, SIDES, sideOf, using } from "../harness.ts"

import { hookIds } from "./fixtures.ts"

export const H8: Scenario = {
  name: "H8 runs the prompt's hook list as the whole set, the agent's list when the prompt lists none, and nothing else",
  requirements: ["216a047a", "41bdae5c", "6fc64bc7", "dce1c8bc", "17286533", "f66e7c81", "f7da5f56", "3b4fc9bc"],
  run: async (driver) => {
    const events: Array<unknown> = []
    const hooks = [
      defineHook({
        hook: "filter_messages",
        id: "f_one",
        execute: async (state, messages, context) => {
          events.push(["f_one", context.source, typeof state.threadId])
          state.context.source = { kind: "prompt", promptName: "imposter" }
          return [...messages, { id: "marker", role: "user", content: "from f_one", created_at: 0 }]
        },
      }),
      defineHook({
        hook: "filter_messages",
        id: "f_two",
        execute: async (_state, messages, context) => {
          events.push(["f_two", context.source, messages.at(-1)?.content])
          return messages
        },
      }),
      defineHook({
        hook: "filter_messages",
        id: "f_agent",
        execute: async (_state, messages, context) => {
          events.push(["f_agent", context.source])
          return messages
        },
      }),
      defineHook({
        hook: "before_create_message",
        id: "c_agent",
        execute: async (_state, message, context) => {
          events.push(["c_agent", message.content, context.source])
          return message
        },
      }),
      defineHook({
        hook: "after_thread_created",
        id: "born",
        execute: async (state, context) => {
          events.push(["born", context.source, state.execution, (await state.getMessages()).total])
          await state.setValue("source", { kind: "prompt", promptName: "imposter" })
        },
      }),
      defineHook({
        hook: "filter_messages",
        id: "f_unused",
        execute: async (_state, messages) => {
          events.push(["f_unused"])
          return messages
        },
      }),
    ]
    const agent = { kind: "agent", agentName: "assistant" }
    const prompt = { kind: "prompt", promptName: "helper" }
    const run = async (humanOn: "a" | "b", lists: Pick<Setup, "agent" | "prompt">) => {
      events.length = 0
      const provider = new ScriptedProvider([{ text: "answer" }])
      const created: Array<unknown> = []
      const named = { ...lists, side: { prompt: "helper" }, prompt: { name: "helper", ...lists.prompt } }
      await using(driver, { provider, hooks, humanOn, ...named }, async (session, thread) => {
        created.push(...events)
        events.length = 0
        await session.send(thread, "go")
      })
      return { created, sent: [...events], request: provider.requests[0] }
    }
    const agentList = { hooks: ["f_agent", "c_agent", "born"] }
    for (const humanOn of SIDES) {
      const both = await run(humanOn, { agent: agentList, prompt: { hooks: ["f_one", "f_two"] } })
      expect(both.created).toEqual([["born", agent, null, 0]])
      expect(both.sent).toEqual([
        ["c_agent", "go", agent],
        ["f_one", prompt, "string"],
        ["f_two", prompt, "from f_one"],
      ])
      expect(history(both.request).map(sideOf)).toEqual([
        ["user", "go"],
        humanOn === "b" ? ["user", "from f_one"] : ["assistant", "from f_one", []],
      ])
    }
    for (const promptList of [{ hooks: [] }, {}]) {
      const fallback = await run("b", { agent: agentList, prompt: promptList })
      expect(fallback.created).toEqual([["born", agent, null, 0]])
      expect(fallback.sent).toEqual([
        ["c_agent", "go", agent],
        ["f_agent", agent],
        ["c_agent", "answer", agent],
      ])
    }
    const neither = await run("b", {})
    expect(neither.created).toEqual([])
    expect(neither.sent).toEqual([])
  },
}

export const H21: Scenario = {
  name: "H21 calls each of the thirteen hook types with ThreadState first, its own arguments, and the context last",
  requirements: ["986689ca", "4b6bc420", "41bdae5c", "bf795e82", "04d1538b", "048a4525"],
  run: async (driver) => {
    const calls: Array<unknown> = []
    const facts: Array<unknown> = []
    const shape = (value: unknown): unknown =>
      Array.isArray(value)
        ? "array"
        : typeof value === "object" && value !== null
          ? Object.keys(value).filter((key) => ["id", "role", "status", "function", "content"].includes(key))
          : typeof value
    const record =
      (name: string, give?: (args: Array<unknown>) => unknown) =>
      async (...args: Array<unknown>) => {
        const state = args[0] as ThreadState
        const context = args.at(-1) as HookExecutionContext
        const execution = state.execution
        if (name === "filter_messages" && execution !== null)
          facts.push([
            execution.stepCount,
            execution.currentSide,
            execution.abortSignal instanceof AbortSignal,
            execution.messageHistory.length,
          ])
        calls.push([
          name,
          typeof state.threadId,
          state.execution === null ? "at rest" : "running",
          args.slice(1, -1).map(shape),
          context.source.kind,
        ])
        return give?.(args.slice(1, -1))
      }
    const positions: Array<[string, ((args: Array<unknown>) => unknown) | undefined]> = [
      ["after_thread_created", undefined],
      ["after_system_message", () => null],
      ["filter_messages", (args) => args[0]],
      ["prefilter_llm_history", (args) => args[0]],
      ["before_create_message", (args) => args[0]],
      ["after_create_message", undefined],
      ["before_update_message", (args) => args[1]],
      ["after_update_message", undefined],
      ["before_store_tool_result", (args) => args[1]],
      ["after_tool_call_success", () => null],
      ["after_tool_call_failure", () => null],
      ["tool_call_started", undefined],
      ["tool_call_done", undefined],
    ]
    const hooks = positions.map(([name, give]) =>
      defineHook({ hook: name as "tool_call_done", id: `every_${name}`, execute: record(name, give) as never }),
    )
    const tools = {
      edit: defineTool({
        description: "Edit the human's message",
        execute: async (state: ThreadState) => {
          const first = state.execution?.messageHistory[0]
          await state.updateMessage(first?.id ?? "", { metadata: { seen: true } })
          return ok("edited")
        },
      }),
      fail: defineTool({
        description: "Fail",
        execute: async () => ({ status: "error" as const, error: "failed" }),
      }),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "edit", arguments: {} },
          { id: "c2", name: "fail", arguments: {} },
        ],
      },
      { text: "done" },
    ])
    await runTurn(driver, { provider, tools, hooks, agent: { hooks: hookIds(hooks) } }, "go")
    const names = new Set(calls.map((call) => (call as Array<unknown>)[0]))
    expect(names.size).toBe(13)
    expect(facts).toEqual([
      [0, "a", true, 1],
      [1, "a", true, 4],
    ])
    const first = (name: string) => calls.find((call) => (call as Array<unknown>)[0] === name) as Array<unknown>
    expect(first("after_thread_created")).toEqual(["after_thread_created", "string", "at rest", [], "agent"])
    expect(first("before_create_message")).toEqual([
      "before_create_message",
      "string",
      "running",
      [["id", "role", "content", "status"]],
      "agent",
    ])
    expect(first("after_system_message")).toEqual(["after_system_message", "string", "running", ["string"], "agent"])
    expect(first("filter_messages")).toEqual(["filter_messages", "string", "running", ["array"], "agent"])
    expect(first("prefilter_llm_history")).toEqual(["prefilter_llm_history", "string", "running", ["array"], "agent"])
    expect(first("before_update_message")).toEqual([
      "before_update_message",
      "string",
      "running",
      ["string", []],
      "agent",
    ])
    expect(first("after_create_message")).toEqual([
      "after_create_message",
      "string",
      "running",
      [["id", "role", "content", "status"]],
      "agent",
    ])
    expect(first("after_update_message")).toEqual([
      "after_update_message",
      "string",
      "running",
      [["id", "role", "content", "status"]],
      "agent",
    ])
    // The create hooks of the human's message run inside the execution that delivers it, so only the creation of the
    // thread runs at rest (Execution State section 1, specification/threads/execution-state.md:3,8-12). M9 proves it.
    expect(
      calls.filter((call) => (call as Array<unknown>)[2] === "at rest").map((call) => (call as Array<unknown>)[0]),
    ).toEqual(["after_thread_created"])
    expect(first("tool_call_started")).toEqual([
      "tool_call_started",
      "string",
      "running",
      [["id", "function"], "undefined"],
      "agent",
    ])
    for (const name of [
      "after_tool_call_success",
      "after_tool_call_failure",
      "before_store_tool_result",
      "tool_call_done",
    ])
      expect(first(name)).toEqual([name, "string", "running", [["id", "function"], ["status"]], "agent"])
  },
}
