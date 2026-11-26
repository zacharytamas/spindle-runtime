import { defineHook, type LLMMessage } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, rolesFor, type Scenario, type Setup, SIDES, using } from "../harness.ts"

import { hookIds } from "./fixtures.ts"

export const H11: Scenario = {
  name: "H11 replays the reasoning of each assistant message that survives the request hooks and of no other, and none when include is false",
  requirements: ["80b5ff9b", "b9e3d243", "6e1d2f01"],
  run: async (driver) => {
    const source = { definition: "scripted", model: "scripted-model-v1" }
    const seed = (humanOn: "a" | "b") => {
      const { human, model } = rolesFor(humanOn)
      return [
        { role: human, content: "q1" },
        {
          role: model,
          content: "a1",
          reasoning_content: "thought one",
          reasoning_details: JSON.stringify([{ type: "text", text: "detail one" }]),
          metadata: { reasoning_source: source },
        },
        { role: human, content: "q2" },
        {
          role: model,
          content: "a2",
          reasoning_content: "thought two",
          reasoning_details: JSON.stringify([{ type: "text", text: "detail two" }]),
          metadata: { reasoning_source: source },
        },
      ]
    }
    const requestOf = async (humanOn: "a" | "b", hooks: Setup["hooks"], include?: boolean) => {
      const provider = new ScriptedProvider([{ text: "done" }])
      await using(
        driver,
        {
          provider,
          humanOn,
          ...(hooks === undefined ? {} : { hooks }),
          prompt: {
            includeChat: true,
            hooks: hookIds(hooks),
            ...(include === undefined ? {} : { reasoning: { include } }),
          },
        },
        async (session, thread) => {
          await session.seed(thread, seed(humanOn))
          await session.send(thread, "q3")
        },
      )
      return provider.requests[0]
    }
    const dropFilter = defineHook({
      hook: "filter_messages",
      id: "drop_a1",
      execute: async (_state, messages) => messages.filter((m) => m.content !== "a1"),
    })
    const dropPrefilter = defineHook({
      hook: "prefilter_llm_history",
      id: "drop_a2",
      execute: async (_state, messages) => messages.filter((m) => m.content !== "a2"),
    })
    const pass = defineHook({
      hook: "prefilter_llm_history",
      id: "pass",
      execute: async (_state, messages) => messages,
    })
    const restore = defineHook({
      hook: "prefilter_llm_history",
      id: "restore",
      execute: async (state, messages) => {
        const stored = state.execution?.messageHistory.find((m) => m.content === "a2")
        return messages.map((m) =>
          m.content === "a2"
            ? {
                ...m,
                reasoning_content: stored?.reasoning_content ?? "",
                reasoning_details: JSON.parse(stored?.reasoning_details ?? "[]"),
              }
            : m,
        )
      },
    })
    const replayed = (n: string, word: string) => ({
      role: "assistant",
      content: `a${n}`,
      reasoning: `thought ${word}`,
      reasoningDetails: [{ type: "text", text: `detail ${word}` }],
    })
    const assistants = (request: Awaited<ReturnType<typeof requestOf>>) =>
      history(request).filter((m) => m.role === "assistant")
    for (const humanOn of SIDES) {
      const plain = await requestOf(humanOn, undefined)
      expect(assistants(plain)).toEqual([replayed("1", "one"), replayed("2", "two")])
      expect(await requestOf(humanOn, [pass])).toEqual(plain)
      expect(assistants(await requestOf(humanOn, [dropFilter]))).toEqual([replayed("2", "two")])
      expect(assistants(await requestOf(humanOn, [dropPrefilter]))).toEqual([replayed("1", "one")])
      const bare = [
        { role: "assistant", content: "a1" },
        { role: "assistant", content: "a2" },
      ]
      const excluded = await requestOf(humanOn, [pass], false)
      expect(assistants(excluded)).toEqual(bare)
      expect(JSON.stringify(excluded)).not.toMatch(/thought|detail/)
      const restored = await requestOf(humanOn, [restore], false)
      expect(assistants(restored)).toEqual(bare)
      expect(JSON.stringify(restored)).not.toMatch(/thought|detail/)
    }
  },
}

export const H11b: Scenario = {
  name: "H11b sends every field of the array prefilter_llm_history returns that a provider message can hold",
  requirements: ["dfde10dc", "5cf7c4b6"],
  run: async (driver) => {
    const requestWith = async (returned: Array<LLMMessage>) => {
      const provider = new ScriptedProvider([{ text: "done" }])
      const hooks = [
        defineHook({
          hook: "prefilter_llm_history",
          id: "final_array",
          execute: async (_state, messages) => [...messages, ...returned],
        }),
      ]
      let logs = ""
      await using(driver, { provider, hooks, prompt: { hooks: ["final_array"] } }, async (session, thread) => {
        await session.send(thread, "go")
        logs = session.logs().join("\n")
      })
      return { history: history(provider.requests[0]), logs }
    }
    const image = { type: "image", data: "aGk=", mediaType: "image/png" }
    const kept = await requestWith([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "x1",
            type: "function",
            function: { name: "noop", arguments: '{"a":1}' },
            extra_content: { sig: "s" },
          },
        ],
        reasoning_content: "why",
        reasoning_details: [{ type: "text", text: "detail" }],
      },
      { role: "tool", tool_call_id: "x1", name: "noop", content: [{ type: "text", text: "wrapped" }] },
      { role: "user", content: [{ type: "text", text: "look" }, image] },
    ])
    expect(kept.history).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "x1", name: "noop", arguments: { a: 1 }, extraContent: { sig: "s" } }],
        reasoning: "why",
        reasoningDetails: [{ type: "text", text: "detail" }],
      },
      { role: "tool", toolCallId: "x1", toolName: "noop", content: [{ type: "text", text: "wrapped" }] },
      { role: "user", content: [{ type: "text", text: "look" }, image] },
    ])
    for (const odd of [
      { role: "assistant", content: [{ type: "text", text: "caption" }, image] },
      { role: "system", content: [{ type: "text", text: "rules" }] },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "x2", function: { name: "noop", arguments: "not json" } }],
      },
      { role: "user", content: [{ type: "image", data: 7 }] },
      { role: "tool", tool_call_id: "x3", name: "noop", content: { type: "text", text: "an object" } },
      {
        role: "tool",
        tool_call_id: "x4",
        name: "noop",
        tool_status: "error",
        content: [{ type: "text", text: "e" }],
      },
    ] as Array<LLMMessage>) {
      const refused = await requestWith([odd])
      expect(refused.history).toEqual([{ role: "user", content: "go" }])
      expect(refused.logs).toContain("Hook final_array (prefilter_llm_history")
    }
  },
}
