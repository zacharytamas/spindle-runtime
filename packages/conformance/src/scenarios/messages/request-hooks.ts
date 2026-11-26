import {
  defineHook,
  definePrompt,
  defineTool,
  type LLMMessage,
  type Message,
  type ThreadState,
} from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, ok, rolesFor, runTurn, type Scenario, SIDES, sideOf, stubTool, using } from "../harness.ts"

import { contents } from "./fixtures.ts"

const noop = { noop: stubTool("Does nothing", "noop") }

const system = { role: "system", content: "You are a test assistant." }

export const M4: Scenario = {
  name: "M4 lets filter_messages and prefilter_llm_history shape only the request while history keeps the stored rows",
  requirements: ["d2ff2793", "2eca3c1a", "5cf7c4b6", "a0834ffa", "cf4e7ca0", "c4905fe6", "77a09885", "07cc7193"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human, model } = rolesFor(humanOn)
      const checks: Array<unknown> = []
      const hooks = [
        defineHook({
          hook: "filter_messages",
          id: "compact",
          execute: async (_state, messages) => {
            const kept: Array<Message> = []
            for (const message of messages) {
              if (message.content === "u1") continue
              if (message.content === "m1") {
                kept.push({ id: "synthetic_summary", role: human, content: "summary of u1 and m1", created_at: 0 })
                continue
              }
              if (message.content === "u2") continue
              if (message.content === "m2") {
                const note = (message.metadata?.note ?? {}) as Record<string, unknown>
                note.secret = "hidden"
                message.content = "m2 edited"
              }
              kept.push(message)
            }
            kept.push({ id: "synthetic_tail", role: human, content: "tail", created_at: 0 })
            return kept
          },
        }),
        defineHook({
          hook: "prefilter_llm_history",
          id: "remind",
          execute: async (_state, messages) => {
            const asked = messages.find((message) => message.content === "u3")
            if (asked !== undefined) asked.content = "u3 (be brief)"
            return [...messages, { role: "user", content: "added by prefilter" }]
          },
        }),
      ]
      const tools = {
        check: defineTool({
          description: "Read the live and the stored history",
          execute: async (state: ThreadState) => {
            checks.push(state.execution?.messageHistory ?? [])
            checks.push((await state.getMessages({ order: "asc", includeSilent: true })).messages)
            return ok("checked")
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "check", arguments: {} }] },
        { text: "done" },
      ])
      await using(
        driver,
        { provider, tools, hooks, humanOn, prompt: { hooks: ["compact", "remind"], includeChat: true } },
        async (session, thread) => {
          await session.seed(thread, [
            { role: human, content: "u1" },
            { role: model, content: "m1" },
            { role: human, content: "u2" },
            { role: model, content: "m2", metadata: { note: { secret: "keep-me" } } },
          ])
          await session.send(thread, "u3")
          const stored = await session.messages(thread)
          expect(history(provider.requests[0]).map(sideOf)).toEqual([
            ["user", "summary of u1 and m1"],
            ["assistant", "m2 edited", []],
            ["user", "u3 (be brief)"],
            ["user", "tail"],
            ["user", "added by prefilter"],
          ])
          expect(provider.requests[0]?.messages[0]).toEqual({ role: "system", content: "You are a test assistant." })
          expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(["check"])
          const original = stored.slice(0, 7)
          expect(contents(original)).toEqual(["u1", "m1", "u2", "m2", "u3", null, "checked"])
          expect(original[3]?.metadata).toEqual({ note: { secret: "keep-me" } })
          expect(checks[0]).toEqual(stored.slice(0, 6))
          expect(checks[1]).toEqual(stored.slice(0, 6))
          expect(stored.map((message) => message.id)).not.toContain("synthetic_summary")
          expect(stored.map((message) => message.id)).not.toContain("synthetic_tail")
          expect(stored.map((message) => message.content)).not.toContain("tail")
          expect(stored.map((message) => message.content)).not.toContain("added by prefilter")
        },
      )
    }
  },
}

export const M5: Scenario = {
  name: "M5 runs the create hooks for a message filter_messages injects and leaves it for the next assembly only",
  requirements: ["0018442c", "62ac4caa", "61b94fc9", "6d8b1d0c", "8a28a42b", "16606350", "1ba43990", "d57ad351"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human } = rolesFor(humanOn)
      const events: Array<unknown> = []
      let injected: Message | undefined
      const hooks = [
        defineHook({
          hook: "filter_messages",
          id: "inject_once",
          execute: async (state, messages) => {
            events.push(["filter", contents(messages)])
            if (injected === undefined) {
              injected = await state.injectMessage({ role: human, content: "from filter", metadata: { tag: "f" } })
              events.push(["read", (await state.getMessage(injected.id))?.content])
            }
            return messages
          },
        }),
        defineHook({
          hook: "prefilter_llm_history",
          id: "peek",
          execute: async (state, messages) => {
            events.push([
              "prefilter",
              contents(messages),
              contents(state.execution?.messageHistory ?? []).includes("from filter"),
            ])
            return messages
          },
        }),
        defineHook({
          hook: "before_create_message",
          id: "lifecycle_before",
          execute: async (_state, message) => {
            if (message.content === "from filter") events.push(["before", message.id])
            return message
          },
        }),
        defineHook({
          hook: "after_create_message",
          id: "lifecycle_after",
          execute: async (_state, message) => {
            if (message.content === "from filter") events.push(["after", message.id])
          },
        }),
      ]
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
        { text: "done" },
      ])
      await using(
        driver,
        {
          provider,
          tools: noop,
          hooks,
          humanOn,
          prompt: { hooks: ["inject_once", "peek", "lifecycle_before", "lifecycle_after"] },
        },
        async (session, thread) => {
          await session.send(thread, "go")
          const id = injected?.id
          expect(events).toEqual([
            ["filter", ["go"]],
            ["before", id],
            ["after", id],
            ["read", "from filter"],
            ["prefilter", ["go"], true],
            ["filter", ["go", "from filter", null, "noop"]],
            ["prefilter", ["go", "from filter", null, "noop"], true],
          ])
          expect(provider.requests).toHaveLength(2)
          expect(provider.requests[0]?.messages).toEqual([system, { role: "user", content: "go" }])
          expect(provider.requests[1]?.messages.filter((m) => m.role === "system")).toEqual([system])
          expect(contents(history(provider.requests[1]))).toContain("from filter")
          expect((await session.messages(thread)).filter((m) => m.content === "from filter")).toHaveLength(1)
        },
      )
    }
  },
}

export const M5b: Scenario = {
  name: "M5b leaves a message that a failing filter_messages hook injected out of the request that hook was filtering",
  requirements: ["41fe7364", "61b94fc9", "6d8b1d0c", "16606350"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human } = rolesFor(humanOn)
      let injected = false
      const hooks = [
        defineHook({
          hook: "filter_messages",
          id: "inject_then_fail",
          execute: async (state) => {
            if (injected) return state.execution?.messageHistory ?? []
            injected = true
            await state.injectMessage({ role: human, content: "from a failing filter" })
            throw new Error("the filter failed after it injected")
          },
        }),
      ]
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
        { text: "done" },
      ])
      await runTurn(driver, { provider, tools: noop, hooks, humanOn, prompt: { hooks: ["inject_then_fail"] } }, "go")
      expect(contents(history(provider.requests[0]))).toEqual(["go"])
      expect(contents(history(provider.requests[1]))).toContain("from a failing filter")
    }
  },
}

export const M6: Scenario = {
  name: "M6 gives a message prefilter_llm_history injects the same snapshot rule and never restarts the assembly",
  requirements: ["8233eb0b", "b7d299a8", "22cf59fa", "000bf2b7", "73bce32e", "e0078c2e", "d57ad351"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human } = rolesFor(humanOn)
      const events: Array<unknown> = []
      let injected: Message | undefined
      const hooks = [
        defineHook({
          hook: "filter_messages",
          id: "count_filter",
          execute: async (_state, messages) => {
            events.push(["filter", contents(messages)])
            return messages
          },
        }),
        defineHook({
          hook: "prefilter_llm_history",
          id: "inject_late",
          execute: async (state, messages) => {
            events.push(["prefilter", contents(messages)])
            if (injected === undefined) {
              injected = await state.injectMessage({ role: human, content: "from prefilter" })
              events.push(["read", (await state.getMessage(injected.id))?.content])
            }
            return messages
          },
        }),
        defineHook({
          hook: "before_create_message",
          id: "creating",
          execute: async (_state, message) => {
            if (message.content === "from prefilter") events.push(["before", message.id])
            return message
          },
        }),
        defineHook({
          hook: "after_create_message",
          id: "created",
          execute: async (_state, message) => {
            if (message.content === "from prefilter") events.push(["after", message.id])
          },
        }),
      ]
      const tools = {
        observe: defineTool({
          description: "Look at the live history",
          execute: async (state: ThreadState) => {
            events.push(["tool", contents(state.execution?.messageHistory ?? [])])
            return ok("observed")
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "observe", arguments: {} }] },
        { text: "done" },
      ])
      await runTurn(
        driver,
        {
          provider,
          tools,
          hooks,
          humanOn,
          prompt: { hooks: ["count_filter", "inject_late", "creating", "created"] },
        },
        "go",
      )
      expect(events).toEqual([
        ["filter", ["go"]],
        ["prefilter", ["go"]],
        ["before", injected?.id],
        ["after", injected?.id],
        ["read", "from prefilter"],
        ["tool", ["go", "from prefilter", null]],
        ["filter", ["go", "from prefilter", null, "observed"]],
        ["prefilter", ["go", "from prefilter", null, "observed"]],
      ])
      expect(provider.requests[0]?.messages).toEqual([system, { role: "user", content: "go" }])
      expect(provider.requests[1]?.messages.filter((m) => m.role === "system")).toEqual([system])
      expect(contents(history(provider.requests[1]))).toContain("from prefilter")
    }
  },
}

export const M7: Scenario = {
  name: "M7 interpolates first, then runs after_system_message, the snapshot, the filter, the transform, the prefilter, and the request",
  requirements: ["67885fd3", "aa659667", "88c209cc", "14d530a7", "29e645c3", "f88b47c5", "6d37745b", "b17aee6d"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human } = rolesFor(humanOn)
      const order: Array<string> = []
      const seen: Array<unknown> = []
      const persisted: Array<unknown> = []
      let injected: Message | undefined
      const hooks = [
        defineHook({
          hook: "after_system_message",
          id: "replace_system",
          execute: async (state, systemMessage) => {
            order.push("after_system_message")
            seen.push(systemMessage)
            injected ??= await state.injectMessage({ role: human, content: "from system hook", silent: true })
            return "REPLACED"
          },
        }),
        defineHook({
          hook: "filter_messages",
          id: "see_filter",
          execute: async (state, messages) => {
            order.push("filter_messages")
            seen.push(messages.map((m) => [m.role, m.content, m.silent]))
            persisted.push(await state.getMessage(injected?.id ?? ""))
            return messages
          },
        }),
        defineHook({
          hook: "prefilter_llm_history",
          id: "final_array",
          execute: async (_state, messages) => {
            order.push("prefilter_llm_history")
            seen.push(messages.map((m: LLMMessage) => [m.role, m.content]))
            return [...messages, { role: "user", content: "final marker" }]
          },
        }),
      ]
      const prompt = definePrompt({
        name: "assistant",
        toolDescription: "Composes",
        model: "scripted",
        prompt: [
          { type: "text", content: "Base. " },
          { type: "include", prompt: "house_rules" },
          { type: "text", content: " Tone: " },
          { type: "env", property: "tone" },
        ],
        variables: [{ name: "tone", type: "text", required: true, description: "Voice" }],
        env: { tone: "warm" },
        hooks: ["replace_system", "see_filter", "final_array"],
      })
      const rules = definePrompt({
        name: "house_rules",
        toolDescription: "Rules",
        model: "scripted",
        prompt: "Be kind.",
      })
      const provider = new ScriptedProvider([
        () => {
          order.push("dispatch")
          return { text: "done" }
        },
      ])
      await using(driver, { provider, hooks, humanOn, prompt, prompts: [rules] }, async (session, thread) => {
        await session.send(thread, "go")
        expect(persisted).toEqual([injected])
        expect((await session.messages(thread)).find((m) => m.id === injected?.id)).toEqual(injected)
        expect(order).toEqual(["after_system_message", "filter_messages", "prefilter_llm_history", "dispatch"])
        expect(seen[0]).toBe("Base. Be kind. Tone: warm")
        expect(seen[1]).toEqual([
          [human, "go", false],
          [human, "from system hook", true],
        ])
        expect(seen[2]).toEqual([
          ["user", "go"],
          ["user", "from system hook"],
        ])
        expect(provider.requests[0]?.messages).toEqual([
          { role: "system", content: "REPLACED" },
          { role: "user", content: "go" },
          { role: "user", content: "from system hook" },
          { role: "user", content: "final marker" },
        ])
      })
    }
  },
}

export const M7b: Scenario = {
  name: "M7b replaces the system message with any returned string, keeps it on null or undefined, and filters once per assembly",
  requirements: ["0018442c", "babeaaef", "bd9fdd64", "a237deef", "a72bbc07", "dfde10dc", "d492805f", "404eb18a"],
  run: async (driver) => {
    const systemOf = async (returns: Array<(system: string) => unknown>) => {
      const filters: Array<number> = []
      const prefilters: Array<unknown> = []
      const hooks = [
        ...returns.map((give, index) =>
          defineHook({
            hook: "after_system_message",
            id: `system_${index}`,
            execute: ((_state: ThreadState, system: string) => give(system)) as () => string,
          }),
        ),
        defineHook({
          hook: "filter_messages",
          id: "count",
          execute: async (_state, messages) => {
            filters.push(messages.length)
            return [...messages, { id: "synthetic", role: "user", content: "filtered", created_at: 0 }]
          },
        }),
        defineHook({
          hook: "prefilter_llm_history",
          id: "mark",
          execute: async (_state, messages) => {
            prefilters.push(messages.map((m) => [m.role, m.content, Array.isArray(m.tool_calls)]))
            return [...messages, { role: "user", content: "marked" }]
          },
        }),
      ]
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
        { text: "done" },
      ])
      let systems: Array<unknown> = []
      await runTurn(
        driver,
        {
          provider,
          tools: noop,
          hooks,
          prompt: { hooks: [...returns.map((_, index) => `system_${index}`), "count", "mark"] },
        },
        "go",
      )
      systems = provider.requests.map((request) => request.messages[0])
      expect(filters).toEqual([1, 3])
      expect(prefilters).toEqual([
        [
          ["user", "go", false],
          ["user", "filtered", false],
        ],
        [
          ["user", "go", false],
          ["assistant", null, true],
          ["tool", "noop", false],
          ["user", "filtered", false],
        ],
      ])
      expect(provider.requests.map((request) => history(request).slice(-2))).toEqual([
        [
          { role: "user", content: "filtered" },
          { role: "user", content: "marked" },
        ],
        [
          { role: "user", content: "filtered" },
          { role: "user", content: "marked" },
        ],
      ])
      return systems
    }
    const rendered = { role: "system", content: "You are a test assistant." }
    expect(await systemOf([() => ""])).toEqual([
      { role: "system", content: "" },
      { role: "system", content: "" },
    ])
    expect(await systemOf([() => null])).toEqual([rendered, rendered])
    expect(await systemOf([async () => undefined])).toEqual([rendered, rendered])
    expect(await systemOf([(system) => `${system} First.`, () => null])).toEqual([
      { role: "system", content: "You are a test assistant. First." },
      { role: "system", content: "You are a test assistant. First." },
    ])
  },
}
