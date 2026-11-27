import {
  defineModel,
  definePrompt,
  defineTool,
  type ModelDefinition,
  type PromptDefinition,
  type ThreadState,
} from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import type { RuntimeDriver } from "../../RuntimeDriver.ts"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import {
  callsOf,
  gate,
  history,
  ok,
  project,
  rolesFor,
  runTurn,
  type Scenario,
  type Setup,
  shape,
  sideOf,
  stubTool,
  toolResults,
  using,
} from "../harness.ts"

const orientation = async (driver: RuntimeDriver, humanOn: "a" | "b") => {
  const { human: humanRole, model: modelRole } = rolesFor(humanOn)
  const provider = new ScriptedProvider([
    { toolCalls: [{ id: "call_own", name: "lookup", arguments: { q: "x" } }] },
    { text: "one" },
    { text: "two" },
  ])
  const tools = {
    lookup: defineTool({
      description: "Look up a word",
      args: z.object({ q: z.string() }),
      execute: async () => ok("found"),
    }),
  }
  await using(
    driver,
    { provider, tools, humanOn, prompt: { includeChat: true, includePastTools: true, tools: ["lookup"] } },
    async (session, thread) => {
      await session.seed(thread, [
        {
          role: humanRole,
          content: "earlier",
          tool_calls: JSON.stringify([
            { id: "call_other", type: "function", function: { name: "other_side_tool", arguments: '{"k":1}' } },
          ]),
        },
        {
          role: "tool",
          content: "other side result",
          name: "other_side_tool",
          tool_call_id: "call_other",
          tool_status: "success",
        },
      ])
      expect(await session.send(thread, "first")).toMatchObject({ status: "idle", reason: "stop_on_response" })
      expect(await session.send(thread, "second")).toMatchObject({ status: "idle", reason: "stop_on_response" })
      const stored = await session.messages(thread)
      expect(stored.map((message) => [message.role, message.content, message.prompt])).toEqual([
        [humanRole, "earlier", null],
        ["tool", "other side result", null],
        [humanRole, "first", null],
        [modelRole, null, "assistant"],
        ["tool", "found", "assistant"],
        [modelRole, "one", "assistant"],
        [humanRole, "second", null],
        [modelRole, "two", "assistant"],
      ])
      expect(history(provider.requests[1]).map(sideOf)).toEqual([
        ["user", "earlier"],
        ["user", "first"],
        ["assistant", null, ["call_own"]],
        ["tool", "call_own"],
      ])
      expect(history(provider.requests[2]).map(sideOf)).toEqual([
        ["user", "earlier"],
        ["user", "first"],
        ["assistant", null, ["call_own"]],
        ["tool", "call_own"],
        ["assistant", "one", []],
        ["user", "second"],
      ])
      for (const request of provider.requests) {
        expect(request.messages[0]?.role).toBe("system")
        expect(JSON.stringify(request)).not.toContain("call_other")
        expect(JSON.stringify(request)).not.toContain("other side result")
      }
    },
  )
}

export const S01: Scenario = {
  name: "S01 persists the response before any tool and each result before the next tool starts",
  requirements: ["ae6194c8", "6362a22f", "9e1310ee", "f6fb47da", "7056a090", "c5f07383", "bd9fdd64", "43d5659d"],
  run: async (driver) => {
    const firstStarted = gate()
    const firstRelease = gate()
    const secondStarted = gate()
    const secondRelease = gate()
    const order: Array<string> = []
    const provider = new ScriptedProvider([
      {
        text: "Saving it.",
        toolCalls: [
          { id: "call_write", name: "write_note", arguments: { value: "blue" } },
          { id: "call_read", name: "read_note", arguments: {} },
        ],
      },
      { text: "The note says blue." },
    ])
    const tools = {
      write_note: defineTool({
        description: "Write a note",
        args: z.object({ value: z.string() }),
        execute: async (state, { value }) => {
          order.push("write:start")
          await state.setValue("note", value)
          firstStarted.release()
          await firstRelease.opened
          order.push("write:end")
          return ok(`wrote ${value}`)
        },
      }),
      read_note: defineTool({
        description: "Read the note",
        execute: async (state: ThreadState) => {
          order.push("read:start")
          const { messages } = await state.getMessages({ order: "asc" })
          const written = messages.find((message) => message.tool_call_id === "call_write")
          secondStarted.release()
          await secondRelease.opened
          order.push("read:end")
          return ok(`read ${String(await state.getValue("note"))} after ${written?.content ?? "nothing"}`)
        },
      }),
    }
    await using(driver, { provider, tools }, async (session, thread) => {
      const running = session.send(thread, "Remember blue")
      await firstStarted.opened
      const atFirstTool = await session.messages(thread)
      expect(shape(atFirstTool)).toEqual([
        ["user", "Remember blue"],
        ["assistant", "Saving it."],
      ])
      expect(callsOf(atFirstTool[1]).map((call) => call.id)).toEqual(["call_write", "call_read"])
      expect(provider.requests).toHaveLength(1)
      firstRelease.release()
      await secondStarted.opened
      const atSecondTool = await session.messages(thread)
      expect(shape(atSecondTool)).toEqual([
        ["user", "Remember blue"],
        ["assistant", "Saving it."],
        ["tool", "call_write"],
      ])
      secondRelease.release()
      const outcome = await running
      expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
      expect(order).toEqual(["write:start", "write:end", "read:start", "read:end"])
      const stored = await session.messages(thread)
      expect(shape(stored)).toEqual([
        ["user", "Remember blue"],
        ["assistant", "Saving it."],
        ["tool", "call_write"],
        ["tool", "call_read"],
        ["assistant", "The note says blue."],
      ])
      expect(stored[3]?.content).toBe("read blue after wrote blue")
      expect(history(provider.requests[1]).map(sideOf)).toEqual([
        ["user", "Remember blue"],
        ["assistant", "Saving it.", ["call_write", "call_read"]],
        ["tool", "call_write"],
        ["tool", "call_read"],
      ])
    })
  },
}

export const S02a: Scenario = {
  name: "S02a presents the model's own turns as assistant and the human's as user when the human is on side B",
  requirements: ["14d530a7", "6e443a4c", "58bf6a6d", "3b206e78", "43bbb05d", "9b948743", "6638d0e6", "778b4467"],
  run: (driver) => orientation(driver, "b"),
}

export const S02b: Scenario = {
  name: "S02b stores a side B model's turns as user and still presents them as assistant when the human is on side A",
  requirements: ["176f7205", "58bf6a6d", "3b206e78", "43bbb05d", "266d6af4", "37cadafc"],
  run: (driver) => orientation(driver, "a"),
}

export const S03: Scenario = {
  name: "S03 renders includes in place and resolves variables by precedence before any request",
  requirements: ["67885fd3", "97e0539c", "a7e2995d", "3a27e944", "8e8bbe20"],
  run: async (driver) => {
    const parts = definePrompt({
      name: "assistant",
      toolDescription: "Composes",
      model: "scripted",
      prompt: [
        { type: "text", content: "A " },
        { type: "include", prompt: "middle" },
        { type: "text", content: " | tone=" },
        { type: "env", property: "tone" },
        { type: "text", content: " | " },
        { type: "include", prompt: "leaf" },
      ],
      variables: [{ name: "tone", type: "text", required: true, description: "Voice" }],
      env: { tone: "prompt-tone" },
      tools: ["root_tool"],
    })
    const middle = definePrompt({
      name: "middle",
      toolDescription: "Middle",
      model: "other",
      prompt: [
        { type: "text", content: "[m " },
        { type: "include", prompt: "leaf" },
        { type: "text", content: " m]" },
      ],
      env: { tone: "middle-tone" },
      tools: ["other_tool"],
    })
    const leaf = definePrompt({ name: "leaf", toolDescription: "Leaf", model: "other", prompt: "  leaf\n" })
    const tools = {
      root_tool: stubTool("Root", "root"),
      other_tool: stubTool("Other", "other"),
    }
    const render = async (
      agentEnv: Record<string, string> | undefined,
      promptEnv: Record<string, string> | undefined,
      instance: Record<string, string>,
    ) => {
      const provider = new ScriptedProvider([{ text: "ok" }])
      const otherProvider = new ScriptedProvider([])
      const setup: Setup = {
        provider,
        prompts: [middle, leaf],
        models: [defineModel({ name: "other", provider: otherProvider.factory, model: "other-model" })],
        tools,
        agent: agentEnv === undefined ? {} : { env: agentEnv },
      }
      const session = await driver.load(
        {
          ...project(setup),
          prompts: [{ ...parts, ...(promptEnv === undefined ? { env: {} } : { env: promptEnv }) }, middle, leaf],
        },
        { instanceEnv: instance },
      )
      try {
        const thread = await session.createThread("assistant")
        const outcome = await session.send(thread, "hi")
        return { outcome, request: provider.requests[0], other: otherProvider.requests.length }
      } finally {
        await session.close()
      }
    }
    const all = await render({ tone: "agent-tone" }, { tone: "prompt-tone" }, { tone: "instance-tone" })
    expect(all.request?.messages[0]).toEqual({
      role: "system",
      content: "A [m   leaf\n m] | tone=agent-tone |   leaf\n",
    })
    expect(all.request?.model).toBe("scripted-model-v1")
    expect(all.request?.tools?.map((tool) => tool.function.name)).toEqual(["root_tool"])
    expect(all.other).toBe(0)
    expect(
      (await render(undefined, { tone: "prompt-tone" }, { tone: "instance-tone" })).request?.messages[0]?.content,
    ).toContain("tone=prompt-tone")
    const instanceOnly = await render(undefined, undefined, { tone: "instance-tone" })
    expect(instanceOnly.outcome.error?.message).toMatch(/^Prompt assistant interpolates variable tone, whose value/)
    expect(instanceOnly.request).toBeUndefined()
    const missing = await render(undefined, undefined, {})
    expect(missing.outcome).toMatchObject({ status: "failed", reason: "fatal_error" })
    expect(missing.outcome.error?.message).toContain("tone")
    expect(missing.request).toBeUndefined()
    const provider = new ScriptedProvider([{ text: "never" }])
    const cyclic = project({
      provider,
      prompts: [
        definePrompt({
          name: "loop_a",
          toolDescription: "A",
          model: "scripted",
          prompt: [{ type: "include", prompt: "loop_b" }],
        }),
        definePrompt({
          name: "loop_b",
          toolDescription: "B",
          model: "scripted",
          prompt: [{ type: "include", prompt: "loop_a" }],
        }),
      ],
    })
    await expect(driver.load(cyclic)).rejects.toThrow(/include/)
    expect(provider.requests).toHaveLength(0)
  },
}

export const S04: Scenario = {
  name: "S04 includeChat and includePastTools admit past turns, and silent messages stay eligible and live",
  requirements: ["a3e64f93", "22a9ddbb", "8254ece3", "dca92c64", "b93f89a4", "07cc7193", "482d644d", "61c7bee3"],
  run: async (driver) => {
    const views: Record<string, unknown> = {}
    for (const [includeChat, includePastTools] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
      [undefined, undefined],
    ] as const) {
      const live: Array<unknown> = []
      let calls = 0
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "call_past", name: "note", arguments: {} }] },
        { text: "a1" },
        { toolCalls: [{ id: "call_now", name: "note", arguments: {} }] },
        { text: "a2" },
      ])
      const tools = {
        note: defineTool({
          description: "Take a note",
          execute: async (state: ThreadState) => {
            calls += 1
            if (calls === 2) {
              live.push(
                (state.execution?.messageHistory ?? []).map((message) => [
                  message.role,
                  message.content,
                  message.silent,
                ]),
              )
              await state.injectMessage({ role: "user", content: "injected quietly", silent: true })
            }
            return ok("noted")
          },
        }),
      }
      const flags = includeChat === undefined ? {} : { includeChat, includePastTools }
      await using(driver, { provider, tools, prompt: flags }, async (session, thread) => {
        await session.send(thread, "u1")
        await session.seed(thread, [{ role: "user", content: "quiet note", silent: true }])
        expect(await session.send(thread, "u2")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        views[`${includeChat}/${includePastTools}`] = history(provider.requests[2]).map(sideOf)
        expect(history(provider.requests[3]).slice(-4).map(sideOf)).toEqual([
          ["user", "u2"],
          ["assistant", null, ["call_now"]],
          ["tool", "call_now"],
          ["user", "injected quietly"],
        ])
      })
      expect(live).toEqual([
        [
          ["user", "u1", false],
          ["assistant", null, false],
          ["tool", "noted", false],
          ["assistant", "a1", false],
          ["user", "quiet note", true],
          ["user", "u2", false],
          ["assistant", null, false],
        ],
      ])
    }
    expect(views["false/false"]).toEqual([["user", "u2"]])
    expect(views["undefined/undefined"]).toEqual(views["false/false"])
    expect(views["true/false"]).toEqual([
      ["user", "u1"],
      ["assistant", "a1", []],
      ["user", "quiet note"],
      ["user", "u2"],
    ])
    expect(views["false/true"]).toEqual([
      ["assistant", null, ["call_past"]],
      ["tool", "call_past"],
      ["user", "u2"],
    ])
    expect(views["true/true"]).toEqual([
      ["user", "u1"],
      ["assistant", null, ["call_past"]],
      ["tool", "call_past"],
      ["assistant", "a1", []],
      ["user", "quiet note"],
      ["user", "u2"],
    ])
  },
}

export const S05: Scenario = {
  name: "S05 sends the native model id and the offered function tools, and runs two returned calls in order",
  requirements: ["db1fad8a", "f3a1cf30", "3faec548", "987763cb", "59cc8ad5", "072413a0", "ec3b4b7f", "f46d5136"],
  run: async (driver) => {
    const events: Array<string> = []
    const tools = {
      lookup: defineTool({
        description: "Look up a word in the glossary",
        args: z.object({ q: z.string().describe("The word to look up"), limit: z.number().int().optional() }),
        execute: async (_state, { q }) => {
          events.push(`${q}:start`)
          await new Promise((resolve) => setTimeout(resolve, 20))
          events.push(`${q}:end`)
          return ok(q)
        },
      }),
      search: stubTool("Search the docs", "searched"),
      hidden_tool: stubTool("Not offered", "hidden"),
    }
    for (const parallelToolCalls of [true, false, undefined]) {
      events.length = 0
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c1", name: "lookup", arguments: { q: "first" } },
            { id: "c2", name: "lookup", arguments: { q: "second" } },
          ],
        },
        { text: "done" },
      ])
      const prompt = {
        tools: ["lookup", { name: "search", env: { REGION: "eu" } }],
        ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
      } as Partial<PromptDefinition>
      await using(driver, { provider, tools, prompt }, async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const request = provider.requests[0]
        expect(request?.model).toBe("scripted-model-v1")
        expect(request?.tools?.map((tool) => tool.function.name)).toEqual(["lookup", "search"])
        expect(request?.tools?.[0]).toMatchObject({
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a word in the glossary",
            parameters: {
              type: "object",
              properties: { q: { type: "string", description: "The word to look up" }, limit: { type: "integer" } },
              required: ["q"],
            },
          },
        })
        expect(request?.tools?.[1]?.function).toMatchObject({ name: "search", description: "Search the docs" })
        if (parallelToolCalls === undefined) expect(request).not.toHaveProperty("parallelToolCalls")
        else expect(request?.parallelToolCalls).toBe(parallelToolCalls)
        expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"])
        expect(toolResults(await session.messages(thread)).map((m) => m.tool_call_id)).toEqual(["c1", "c2"])
      })
    }
  },
}

export const S06a: Scenario = {
  name: "S06a merges provider options from the model and then the prompt, later keys winning",
  requirements: ["d7549987", "ec3b4b7f", "a0076042", "bf553948"],
  run: async (driver) => {
    const provider = new ScriptedProvider([{ text: "ok" }, { text: "ok" }])
    await runTurn(
      driver,
      {
        provider,
        prompt: { providerOptions: { b: 2, shared: "prompt" } } as Partial<PromptDefinition>,
        model: { providerOptions: { a: 1, shared: "model", nested: { keep: true } } },
      },
      "hi",
    )
    expect(provider.requests[0]?.providerOptions).toEqual({ a: 1, shared: "prompt", nested: { keep: true }, b: 2 })
    const plain = new ScriptedProvider([{ text: "ok" }])
    await runTurn(driver, { provider: plain }, "hi")
    expect(plain.requests[0]).not.toHaveProperty("providerOptions")
  },
}

export const S06b: Scenario = {
  name: "S06b carries the prompt's reasoning level, token limit, and exclusion with the model's declared levels",
  requirements: ["57723af5", "1caa81d5", "171552a1", "cc611236", "3f5e07ed", "29d03e8b", "132940db", "c4839f4c"],
  run: async (driver) => {
    const levels = { 0: "none", 33: "low", 66: "medium", 100: "high" }
    const requestFor = async (prompt: Partial<PromptDefinition>, model: Partial<ModelDefinition>) => {
      const provider = new ScriptedProvider([{ text: "ok" }])
      await runTurn(driver, { provider, prompt, model }, "hi")
      return provider.requests[0]
    }
    const full = await requestFor(
      { reasoning: { level: 57, maxTokens: 512, exclude: true, include: false } },
      { capabilities: { reasoningLevels: levels } },
    )
    expect(full?.reasoning).toEqual({ level: 57, levels, maxTokens: 512, exclude: true })
    const zero = await requestFor({ reasoning: { level: 0 } }, { capabilities: { reasoningLevels: levels } })
    expect(zero?.reasoning).toEqual({ level: 0, levels })
    const undeclared = await requestFor({ reasoning: { level: 40 } }, {})
    expect(undeclared?.reasoning).toEqual({ level: 40 })
    const unset = await requestFor({ reasoning: { maxTokens: 100 } }, { capabilities: { reasoningLevels: levels } })
    expect(unset?.reasoning).toEqual({ maxTokens: 100 })
    expect(await requestFor({}, {})).not.toHaveProperty("reasoning")
  },
}

export const S24: Scenario = {
  name: "S24 keeps stored attachment references intact and describes them in the request",
  requirements: ["149b9d7b", "244b7d29"],
  run: async (driver) => {
    const chart = {
      id: "att_1",
      type: "file" as const,
      path: "/attachments/chart.png",
      name: "chart.png",
      mimeType: "image/png",
      size: 2048,
      width: 640,
      height: 480,
      description: "A bar chart",
    }
    const notes = {
      id: "att_2",
      type: "file" as const,
      path: "/attachments/notes.txt",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 12,
    }
    const provider = new ScriptedProvider([{ text: "seen" }])
    await using(
      driver,
      { provider, prompt: { includeChat: true, recentImageThreshold: 1 } },
      async (session, thread) => {
        await session.seed(thread, [{ role: "user", content: "see attached", attachments: [chart, notes] }])
        await session.send(thread, "what is in it?")
        expect((await session.messages(thread))[0]?.attachments).toEqual([chart, notes])
      },
    )
    expect(history(provider.requests[0]).map(sideOf)).toEqual([
      [
        "user",
        "see attached\n[Attachment chart.png (image/png, 640x480) at /attachments/chart.png: A bar chart]\n[Attachment notes.txt (text/plain) at /attachments/notes.txt]",
      ],
      ["user", "what is in it?"],
    ])
  },
}

export const S35: Scenario = {
  name: "S35 leaves a message injected during tools out of the current request and puts it in the next one",
  requirements: ["88c209cc", "41fe7364", "8233eb0b", "6d37745b", "16606350"],
  run: async (driver) => {
    const tools = {
      inject: defineTool({
        description: "Inject a note",
        execute: async (state: ThreadState) => {
          await state.injectMessage({ role: "system", content: "late note" })
          return ok("injected")
        },
      }),
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "inject", arguments: {} }] },
      { text: "done" },
    ])
    await using(driver, { provider, tools, prompt: { includeChat: true } }, async (session, thread) => {
      await session.seed(thread, [{ role: "system", content: "early note" }])
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
    })
    expect(provider.requests).toHaveLength(2)
    expect((provider.requests[0]?.messages ?? []).slice(1).map(sideOf)).toEqual([
      ["system", "early note"],
      ["user", "go"],
    ])
    expect((provider.requests[1]?.messages ?? []).slice(1).map(sideOf)).toEqual([
      ["system", "early note"],
      ["user", "go"],
      ["assistant", null, ["c1"]],
      ["tool", "c1"],
      ["system", "late note"],
    ])
  },
}
