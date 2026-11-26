import {
  type AgentDefinition,
  defineAgent,
  defineHook,
  defineModel,
  definePrompt,
  defineProvider,
  defineTool,
  type Message,
  type ModelDefinition,
  type PromptDefinition,
  ProviderError,
  type ProviderFactoryWithOptions,
  type ProviderMessage,
  type ProviderStreamChunk,
  providerEnv,
  type ResponseSummary,
  type ThreadState,
} from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import type { Project, RunOutcome, RuntimeDriver, RuntimeSession, SendOptions } from "../RuntimeDriver.ts"
import { type RecordedRequest, ScriptedProvider, type ScriptStep } from "../ScriptedProvider.ts"

export interface Scenario {
  readonly name: string
  // The requirement ids, without the page prefix, that the scenario proves. The ledger holds the full ids.
  readonly requirements: ReadonlyArray<string>
  readonly run: (driver: RuntimeDriver) => Promise<void>
}

// biome-ignore lint/suspicious/noExplicitAny: tools differ in their argument types.
type Tools = Record<string, any>

export interface Setup {
  readonly provider: ScriptedProvider
  readonly prompt?: Partial<PromptDefinition>
  readonly prompts?: ReadonlyArray<PromptDefinition>
  readonly side?: Partial<AgentDefinition["sideA"]>
  readonly agent?: Partial<AgentDefinition>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly humanOn?: "a" | "b"
  readonly model?: Partial<ModelDefinition>
  readonly models?: ReadonlyArray<ModelDefinition>
  readonly tools?: Tools
  readonly hooks?: Project["hooks"]
}

export const project = (setup: Setup): Project => {
  const side = { prompt: "assistant", ...setup.side } as AgentDefinition["sideA"]
  const human = { human: true } as const
  return {
    models: [
      defineModel({ name: "scripted", provider: setup.provider.factory, model: "scripted-model-v1", ...setup.model }),
      ...(setup.models ?? []),
    ],
    prompts: [
      definePrompt({
        name: "assistant",
        toolDescription: "Answers questions",
        model: "scripted",
        prompt: "You are a test assistant.",
        tools: Object.keys(setup.tools ?? {}),
        ...setup.prompt,
      } as PromptDefinition),
      ...(setup.prompts ?? []),
    ],
    agents: [
      defineAgent({
        name: "assistant",
        ...(setup.humanOn === "a" ? { sideA: human, sideB: side } : { sideA: side, sideB: human }),
        ...setup.agent,
      } as AgentDefinition),
      ...(setup.agents ?? []),
    ],
    tools: setup.tools ?? {},
    ...(setup.hooks === undefined ? {} : { hooks: setup.hooks }),
  }
}

export const open = async (driver: RuntimeDriver, setup: Setup, instanceEnv?: Record<string, string>) => {
  const session = await driver.load(project(setup), instanceEnv === undefined ? {} : { instanceEnv })
  const thread = await session.createThread("assistant")
  return { session, thread }
}

export const using = async (
  driver: RuntimeDriver,
  setup: Setup,
  body: (session: RuntimeSession, thread: string) => Promise<void>,
  instanceEnv?: Record<string, string>,
) => {
  const { session, thread } = await open(driver, setup, instanceEnv)
  try {
    await body(session, thread)
  } finally {
    await session.close()
  }
}

export const gate = () => {
  let release: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, opened }
}

export const ok = (result: string) => ({ status: "success" as const, result })

export const callsOf = (message: Message | undefined) =>
  JSON.parse(message?.tool_calls ?? "[]") as Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>

// Every key and string inside a value, and inside each string that holds JSON, so that a search finds a value under
// any field and inside a JSON column, decoded.
const stringsIn = (value: unknown): Array<string> => {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return [value, ...(typeof parsed === "object" && parsed !== null ? stringsIn(parsed) : [])]
    } catch {
      return [value]
    }
  }
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, member]) => [key, ...stringsIn(member)])
}

export const holding = (value: unknown, secret: string) => stringsIn(value).filter((text) => text.includes(secret))

const shape = (messages: ReadonlyArray<Message>) =>
  messages.map((message) => [message.role, message.role === "tool" ? message.tool_call_id : message.content])

export const history = (request: RecordedRequest | undefined) =>
  (request?.messages ?? []).filter((message) => message.role !== "system")

export const sideOf = (message: ProviderMessage) =>
  message.role === "assistant"
    ? ["assistant", message.content ?? null, (message.toolCalls ?? []).map((call) => call.id)]
    : message.role === "tool"
      ? ["tool", message.toolCallId]
      : [message.role, message.content]

const counter = () => {
  let count = 0
  return {
    get count() {
      return count
    },
    tick: <A>(value: A) => {
      count += 1
      return value
    },
  }
}

export const send = (
  session: RuntimeSession,
  thread: string,
  text: string,
  options?: SendOptions,
): Promise<RunOutcome> => session.send(thread, text, options)

const orientation = async (driver: RuntimeDriver, humanOn: "a" | "b") => {
  const humanRole = humanOn === "b" ? "user" : "assistant"
  const modelRole = humanOn === "b" ? "assistant" : "user"
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
      expect(await send(session, thread, "first")).toMatchObject({ status: "idle", reason: "stop_on_response" })
      expect(await send(session, thread, "second")).toMatchObject({ status: "idle", reason: "stop_on_response" })
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

export const stepLoopScenarios: ReadonlyArray<Scenario> = [
  {
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
        const running = send(session, thread, "Remember blue")
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
  },
  {
    name: "S02a presents the model's own turns as assistant and the human's as user when the human is on side B",
    requirements: ["14d530a7", "6e443a4c", "58bf6a6d", "3b206e78", "43bbb05d", "9b948743", "6638d0e6", "778b4467"],
    run: (driver) => orientation(driver, "b"),
  },
  {
    name: "S02b stores a side B model's turns as user and still presents them as assistant when the human is on side A",
    requirements: ["176f7205", "58bf6a6d", "3b206e78", "43bbb05d", "266d6af4", "37cadafc"],
    run: (driver) => orientation(driver, "a"),
  },
  {
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
        root_tool: defineTool({ description: "Root", execute: async () => ok("root") }),
        other_tool: defineTool({ description: "Other", execute: async () => ok("other") }),
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
          const outcome = await send(session, thread, "hi")
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
  },
  {
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
          await send(session, thread, "u1")
          await session.seed(thread, [{ role: "user", content: "quiet note", silent: true }])
          expect(await send(session, thread, "u2")).toMatchObject({ status: "idle", reason: "stop_on_response" })
          views[`${includeChat}/${includePastTools}`] = history(provider.requests[2]).map(sideOf)
          expect(history(provider.requests[3]).slice(-4).map(sideOf)).toEqual([
            ["user", "u2"],
            ["assistant", null, ["call_now"]],
            ["user", "injected quietly"],
            ["tool", "call_now"],
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
  },
  {
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
        search: defineTool({ description: "Search the docs", execute: async () => ok("searched") }),
        hidden_tool: defineTool({ description: "Not offered", execute: async () => ok("hidden") }),
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
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
          expect((await session.messages(thread)).filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual([
            "c1",
            "c2",
          ])
        })
      }
    },
  },
  {
    name: "S06a merges provider options from the model and then the prompt, later keys winning",
    requirements: ["d7549987", "ec3b4b7f", "a0076042", "bf553948"],
    run: async (driver) => {
      const provider = new ScriptedProvider([{ text: "ok" }, { text: "ok" }])
      await using(
        driver,
        {
          provider,
          prompt: { providerOptions: { b: 2, shared: "prompt" } } as Partial<PromptDefinition>,
          model: { providerOptions: { a: 1, shared: "model", nested: { keep: true } } },
        },
        async (session, thread) => {
          await send(session, thread, "hi")
        },
      )
      expect(provider.requests[0]?.providerOptions).toEqual({ a: 1, shared: "prompt", nested: { keep: true }, b: 2 })
      const plain = new ScriptedProvider([{ text: "ok" }])
      await using(driver, { provider: plain }, async (session, thread) => {
        await send(session, thread, "hi")
      })
      expect(plain.requests[0]).not.toHaveProperty("providerOptions")
    },
  },
  {
    name: "S06b carries the prompt's reasoning level, token limit, and exclusion with the model's declared levels",
    requirements: ["57723af5", "1caa81d5", "171552a1", "cc611236", "3f5e07ed", "29d03e8b", "132940db", "c4839f4c"],
    run: async (driver) => {
      const levels = { 0: "none", 33: "low", 66: "medium", 100: "high" }
      const requestFor = async (prompt: Partial<PromptDefinition>, model: Partial<ModelDefinition>) => {
        const provider = new ScriptedProvider([{ text: "ok" }])
        await using(driver, { provider, prompt, model }, async (session, thread) => {
          await send(session, thread, "hi")
        })
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
  },
  {
    name: "S07 passes toolChoice through, sends none with the definitions, and never runs a call the prompt forbids",
    requirements: ["539cf227", "d0ac352d", "20479ea7", "975e02f5", "ea4bf54e", "2f53909a"],
    run: async (driver) => {
      const runs = counter()
      const tools = { act: defineTool({ description: "Act", execute: async () => runs.tick(ok("acted")) }) }
      const call = { toolCalls: [{ name: "act", arguments: {} }] }
      const auto = new ScriptedProvider([call, { text: "done" }])
      await using(driver, { provider: auto, tools, prompt: { toolChoice: "auto" } }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
      })
      expect(auto.requests[0]?.toolChoice).toBe("auto")
      expect(runs.count).toBe(1)
      const unset = new ScriptedProvider([{ text: "done" }])
      await using(driver, { provider: unset, tools }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 1 })
      })
      expect(unset.requests[0]).not.toHaveProperty("toolChoice")
      const required = new ScriptedProvider([call])
      await using(
        driver,
        { provider: required, tools, prompt: { toolChoice: "required" }, side: { maxSteps: 1 } },
        async (session, thread) => {
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", reason: "max_side_steps" })
        },
      )
      expect(required.requests[0]?.toolChoice).toBe("required")
      expect(runs.count).toBe(2)
      const none = new ScriptedProvider([call, { text: "no tools used" }])
      await using(driver, { provider: none, tools, prompt: { toolChoice: "none" } }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({
          status: "idle",
          reason: "stop_on_response",
          steps: 1,
        })
        expect(shape(await session.messages(thread))).toEqual([
          ["user", "go"],
          ["assistant", "no tools used"],
        ])
      })
      expect(none.requests).toHaveLength(2)
      expect(none.requests[0]?.toolChoice).toBe("none")
      expect(none.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(["act"])
      expect(runs.count).toBe(2)
      const stubborn = new ScriptedProvider([call, call])
      await using(driver, { provider: stubborn, tools, prompt: { toolChoice: "none" } }, async (session, thread) => {
        const outcome = await send(session, thread, "go", { retries: 1 })
        expect(outcome).toMatchObject({ status: "failed", reason: "step_error" })
        expect(outcome.error?.message).toContain("none")
        expect(shape(await session.messages(thread))).toEqual([["user", "go"]])
      })
      expect(runs.count).toBe(2)
    },
  },
  {
    name: "S08 retries a response without a tool call when the prompt requires one, within the retry budget",
    requirements: ["cb3cc2b1"],
    run: async (driver) => {
      const runs = counter()
      const tools = { act: defineTool({ description: "Act", execute: async () => runs.tick(ok("acted")) }) }
      const provider = new ScriptedProvider([
        { text: "I would rather talk" },
        { toolCalls: [{ name: "act", arguments: {} }] },
      ])
      await using(
        driver,
        { provider, tools, prompt: { toolChoice: "required" }, side: { maxSteps: 1 } },
        async (session, thread) => {
          const outcome = await send(session, thread, "go")
          expect(outcome).toMatchObject({ status: "idle", reason: "max_side_steps", steps: 1 })
          expect(outcome.modelCalls.map((call) => call.rejected === undefined)).toEqual([false, true])
          expect((await session.messages(thread)).map((message) => message.role)).toEqual(["user", "assistant", "tool"])
        },
      )
      expect(provider.requests).toHaveLength(2)
      expect(runs.count).toBe(1)
      const stubborn = new ScriptedProvider([{ text: "no" }, { text: "still no" }])
      await using(
        driver,
        { provider: stubborn, tools, prompt: { toolChoice: "required" } },
        async (session, thread) => {
          const outcome = await send(session, thread, "go", { retries: 1 })
          expect(outcome).toMatchObject({ status: "failed", reason: "step_error", steps: 0 })
          expect(shape(await session.messages(thread))).toEqual([["user", "go"]])
        },
      )
      expect(stubborn.requests).toHaveLength(2)
    },
  },
  {
    name: "S09 assembles one response from interleaved chunks and stores calls in first-seen order with JSON arguments",
    requirements: ["83735bf6", "7abccc72", "c0dc1ab1", "6a7975b1", "d50d7c17", "a5a61544", "f3f5c522"],
    run: async (driver) => {
      const tools = {
        lookup: defineTool({
          description: "Look up",
          args: z.object({ q: z.string() }),
          execute: async (_state, { q }) => ok(`found ${q}`),
        }),
      }
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
      const chunks: Array<ProviderStreamChunk> = [
        { type: "reasoning-delta", delta: "think " },
        { type: "content-delta", delta: "Hel" },
        { type: "tool-call-start", id: "call_A", name: "lookup" },
        { type: "reasoning-delta", delta: "more" },
        { type: "tool-call-start", id: "call_B", name: "lookup" },
        { type: "tool-call-delta", id: "call_A", argumentsDelta: '{"q":"\\u00' },
        { type: "content-delta", delta: "lo" },
        { type: "tool-call-delta", id: "call_B", argumentsDelta: '{"q":"b"}' },
        { type: "tool-call-done", id: "call_B", arguments: { q: "b" } },
        { type: "tool-call-delta", id: "call_A", argumentsDelta: 'e9"}' },
        { type: "tool-call-done", id: "call_A", arguments: { q: "é" } },
        { type: "reasoning-done" },
        { type: "content-done" },
        {
          type: "finish",
          finishReason: "tool_calls",
          usage,
          reasoningDetails: [{ type: "encrypted", data: "opaque", format: "test-v1" }],
        },
      ]
      const provider = new ScriptedProvider([{ chunks }, { text: "done" }])
      await using(driver, { provider, tools }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const [, assistant, first, second, final] = await session.messages(thread)
        expect(assistant).toMatchObject({
          role: "assistant",
          content: "Hello",
          reasoning_content: "think more",
          reasoning_details: JSON.stringify([{ type: "encrypted", data: "opaque", format: "test-v1" }]),
        })
        const calls = callsOf(assistant)
        expect(calls.map((call) => [call.id, call.type, call.function.name])).toEqual([
          ["call_A", "function", "lookup"],
          ["call_B", "function", "lookup"],
        ])
        expect(calls.map((call) => JSON.parse(call.function.arguments))).toEqual([{ q: "é" }, { q: "b" }])
        expect([first, second].map((m) => [m?.tool_call_id, m?.name, m?.content])).toEqual([
          ["call_A", "lookup", "found é"],
          ["call_B", "lookup", "found b"],
        ])
        expect(final).toMatchObject({ content: "done", reasoning_content: null, reasoning_details: null })
      })
    },
  },
  {
    name: "S10 replays persisted reasoning unless include is false, and never for a message outside the request",
    requirements: ["7abccc72", "80b5ff9b", "b9e3d243", "bbc2f60d", "c0dc1ab1", "aea91179", "13e0d197", "6e1d2f01"],
    run: async (driver) => {
      const responses: Array<ScriptStep> = [
        { text: "t1", reasoning: "r1" },
        { text: "t2", reasoningDetails: [{ type: "text", text: "d2" }] },
        { text: "t3", reasoning: "r3", reasoningDetails: [{ type: "summary", text: "d3" }] },
        { text: "t4" },
        { text: "t5" },
      ]
      const other = new ScriptedProvider([])
      const run = async (prompt: Partial<PromptDefinition>) => {
        const provider = new ScriptedProvider(responses)
        let stored: ReadonlyArray<Message> = []
        await using(
          driver,
          {
            provider,
            prompt,
            prompts: [
              definePrompt({ name: "other", toolDescription: "Other", model: "other_model", prompt: "Other." }),
            ],
            models: [defineModel({ name: "other_model", provider: other.factory, model: "other-model-v1" })],
          },
          async (session, thread) => {
            for (const text of ["q1", "q2", "q3", "q4"]) await send(session, thread, text)
            await session.seed(thread, [
              {
                role: "assistant",
                content: "from another model",
                reasoning_content: "ro",
                reasoning_details: JSON.stringify([{ type: "encrypted", data: "foreign" }]),
                prompt: "other",
              },
              {
                role: "assistant",
                content: "same prompt, earlier model",
                reasoning_details: JSON.stringify([{ type: "encrypted", data: "stale" }]),
                prompt: "assistant",
              },
              ...[
                ["same model, fields reordered", { model: "scripted-model-v1", definition: "scripted" }],
                ["other definition", { definition: "other_model", model: "scripted-model-v1" }],
                ["other native model", { definition: "scripted", model: "scripted-model-v0" }],
              ].map(([content, source]) => ({
                role: "assistant" as const,
                content: content as string,
                reasoning_details: JSON.stringify([{ type: "encrypted", data: `sealed ${content}` }]),
                prompt: "assistant",
                metadata: { reasoning_source: source },
              })),
            ])
            await send(session, thread, "q5")
            stored = await session.messages(thread)
          },
        )
        return { request: provider.requests[4], stored }
      }
      const replayed = await run({ includeChat: true })
      const assistants = history(replayed.request).filter((message) => message.role === "assistant")
      expect(
        assistants.map((message) => [
          message.role === "assistant" ? message.content : null,
          message.role === "assistant" ? (message.reasoning ?? null) : null,
          message.role === "assistant" ? (message.reasoningDetails ?? null) : null,
        ]),
      ).toEqual([
        ["t1", "r1", null],
        ["t2", null, [{ type: "text", text: "d2" }]],
        ["t3", "r3", [{ type: "summary", text: "d3" }]],
        ["t4", null, null],
        ["from another model", "ro", null],
        ["same prompt, earlier model", null, null],
        ["same model, fields reordered", null, [{ type: "encrypted", data: "sealed same model, fields reordered" }]],
        ["other definition", null, null],
        ["other native model", null, null],
      ])
      const explicit = await run({ includeChat: true, reasoning: { include: true } })
      expect(history(explicit.request)).toEqual(history(replayed.request))
      expect(
        replayed.stored.filter((m) => m.role === "assistant").map((m) => [m.reasoning_content, m.reasoning_details]),
      ).toEqual([
        ["r1", null],
        [null, JSON.stringify([{ type: "text", text: "d2" }])],
        ["r3", JSON.stringify([{ type: "summary", text: "d3" }])],
        [null, null],
        ["ro", JSON.stringify([{ type: "encrypted", data: "foreign" }])],
        [null, JSON.stringify([{ type: "encrypted", data: "stale" }])],
        ...["same model, fields reordered", "other definition", "other native model"].map((content) => [
          null,
          JSON.stringify([{ type: "encrypted", data: `sealed ${content}` }]),
        ]),
        [null, null],
      ])
      const withheld = await run({ includeChat: true, reasoning: { include: false } })
      const text = JSON.stringify(withheld.request)
      for (const marker of ['"r1"', '"d2"', '"r3"', '"d3"', '"ro"', "foreign", "stale", "sealed"])
        expect(text).not.toContain(marker)
      expect(withheld.stored.filter((m) => m.role === "assistant")[0]?.reasoning_content).toBe("r1")
      const excluded = await run({})
      expect(history(excluded.request).map(sideOf)).toEqual([["user", "q5"]])
      expect(JSON.stringify(excluded.request)).not.toContain("r1")
    },
  },
  {
    name: "S11 fetches response metadata beside the loop and waits for it only before the run settles",
    requirements: ["016dca2f", "d20be44c", "a894b520", "b68429b5", "6eb61992"],
    run: async (driver) => {
      const metadataGate = gate()
      const secondRequest = gate()
      const summaries: Array<ResponseSummary> = []
      const completedAtCall: Array<number> = []
      let pendingAtSecondRequest = false
      let firstMetadataDone = false
      const provider = new ScriptedProvider(
        [
          {
            toolCalls: [{ id: "c1", name: "note", arguments: {} }],
            usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10, cachedTokens: 0, cost: 0 },
          },
          () => {
            pendingAtSecondRequest = !firstMetadataDone
            secondRequest.release()
            return { text: "done" }
          },
        ],
        {
          getResponseMetadata: async (summary) => {
            completedAtCall.push(provider.completedStreams)
            const generation = summaries.push(summary)
            if (generation === 1) {
              await metadataGate.opened
              firstMetadataDone = true
            }
            return { generation }
          },
        },
      )
      const tools = { note: defineTool({ description: "Note", execute: async () => ok("noted") }) }
      await using(driver, { provider, tools }, async (session, thread) => {
        const running = send(session, thread, "go")
        await secondRequest.opened
        expect(pendingAtSecondRequest).toBe(true)
        const early = await Promise.race([
          running.then(() => "settled"),
          new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
        ])
        expect(early).toBe("waiting")
        metadataGate.release()
        const outcome = await running
        expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response" })
        expect(outcome.modelCalls.map((call) => call.metadata)).toEqual([{ generation: 1 }, { generation: 2 }])
        expect(completedAtCall.map((completed, index) => completed > index)).toEqual([true, true])
        expect(outcome.modelCalls[0]?.usage).toEqual({
          promptTokens: 7,
          completionTokens: 3,
          totalTokens: 10,
          cachedTokens: 0,
          cost: 0,
        })
        expect(summaries[0]).toEqual({
          model: "scripted-model-v1",
          finishReason: "tool_calls",
          usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        })
      })
    },
  },
  {
    name: "S12 validates arguments against the tool schema and runs execute only with the parsed values",
    requirements: ["f3a1cf30", "e2a1037e", "5522b4f9", "2cf0753e"],
    run: async (driver) => {
      const received: Array<unknown> = []
      const tools = {
        book: defineTool({
          description: "Book a room",
          args: z
            .object({
              room: z.object({ floor: z.number().int().min(1), name: z.string() }),
              nights: z.number().default(1),
              note: z.string().optional(),
              vip: z.boolean(),
            })
            .refine((args) => args.nights <= 14, { message: "A stay is at most 14 nights" }),
          execute: async (state, args) => {
            received.push(args)
            await state.setValue("bookings", Number((await state.getValue("bookings")) ?? 0) + 1)
            return ok(JSON.stringify(args))
          },
        }),
        ping: defineTool({ description: "Ping", execute: async () => ok("pong") }),
        bookings: defineTool({
          description: "Count bookings",
          execute: async (state: ThreadState) => ok(String((await state.getValue("bookings")) ?? 0)),
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "valid", name: "book", arguments: { room: { floor: 2, name: "Blue" }, vip: true } },
            { id: "wrong_type", name: "book", arguments: { room: { floor: "two", name: "Blue" }, vip: true } },
            { id: "missing", name: "book", arguments: { room: { floor: 1, name: "Red" } } },
            { id: "too_long", name: "book", arguments: { room: { floor: 1, name: "Red" }, vip: false, nights: 30 } },
            { id: "falsy", name: "book", arguments: { room: { floor: 1, name: "" }, vip: false, nights: 0, note: "" } },
            { id: "ping", name: "ping", arguments: {} },
            { id: "count", name: "bookings", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        expect(await send(session, thread, "book")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        const results = (await session.messages(thread)).filter((message) => message.role === "tool")
        expect(results.map((m) => [m.tool_call_id, m.tool_status])).toEqual([
          ["valid", "success"],
          ["wrong_type", "error"],
          ["missing", "error"],
          ["too_long", "error"],
          ["falsy", "success"],
          ["ping", "success"],
          ["count", "success"],
        ])
        expect(results[1]?.content).toContain("room.floor")
        expect(results[2]?.content).toContain("vip")
        expect(results[3]?.content).toContain("A stay is at most 14 nights")
        expect(results[6]?.content).toBe("2")
      })
      expect(received).toEqual([
        { room: { floor: 2, name: "Blue" }, nights: 1, vip: true },
        { room: { floor: 1, name: "" }, nights: 0, note: "", vip: false },
      ])
    },
  },
  {
    name: "S13 never runs a call whose streamed arguments are not a JSON object and still runs its sibling",
    requirements: ["732b2d4b", "6a7975b1"],
    run: async (driver) => {
      const seen: Array<string> = []
      const tools = {
        lookup: defineTool({
          description: "Look up",
          args: z.object({ q: z.string() }),
          execute: async (_state, { q }) => {
            seen.push(q)
            return ok(`found ${q}`)
          },
        }),
      }
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
      const provider = new ScriptedProvider([
        {
          chunks: [
            { type: "tool-call-start", id: "broken", name: "lookup" },
            { type: "tool-call-delta", id: "broken", argumentsDelta: '{"q": "unterminated' },
            { type: "tool-call-start", id: "fine", name: "lookup" },
            { type: "tool-call-delta", id: "fine", argumentsDelta: '{"q":"ok"}' },
            { type: "tool-call-done", id: "fine", arguments: { q: "ok" } },
            { type: "finish", finishReason: "tool_calls", usage },
          ],
        },
        { text: "done" },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        const stored = await session.messages(thread)
        expect(callsOf(stored[1]).map((call) => [call.id, JSON.parse(call.function.arguments)])).toEqual([
          ["broken", { invalid_json: '{"q": "unterminated' }],
          ["fine", { q: "ok" }],
        ])
        const results = stored.filter((message) => message.role === "tool")
        expect(results.map((m) => [m.tool_call_id, m.name, m.tool_status])).toEqual([
          ["broken", "lookup", "error"],
          ["fine", "lookup", "success"],
        ])
        expect(results[0]?.content).toContain("not a valid JSON object")
      })
      expect(seen).toEqual(["ok"])
      const replayed = history(provider.requests[1]).find((message) => message.role === "assistant")
      expect(replayed?.role === "assistant" ? replayed.toolCalls?.map((call) => call.arguments) : []).toEqual([
        { invalid_json: '{"q": "unterminated' },
        { q: "ok" },
      ])
    },
  },
  {
    name: "S14 stores every tool outcome as a named, linked result and keeps the loop running",
    requirements: ["732b2d4b", "5522b4f9", "2cf0753e", "2d964c36", "968989f2", "41278e5e", "3b0dd02b"],
    run: async (driver) => {
      const tools = {
        soft: defineTool({
          description: "Fails softly",
          execute: async () => ({ status: "error", error: "soft fail" }),
        }),
        boom: defineTool({
          description: "Throws",
          execute: async () => {
            throw new Error("kaboom")
          },
        }),
        reject: defineTool({ description: "Rejects", execute: () => Promise.reject(new Error("rejected")) }),
        weird: defineTool({
          description: "Throws a value",
          execute: async () => {
            throw { reason: 42 }
          },
        }),
        fine: defineTool({ description: "Works", execute: async () => ok("fine") }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: ["soft", "boom", "reject", "weird", "fine"].map((name) => ({
            id: `call_${name}`,
            name,
            arguments: {},
          })),
        },
        { text: "recovered" },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({
          status: "idle",
          reason: "stop_on_response",
          steps: 2,
        })
        const results = (await session.messages(thread)).filter((message) => message.role === "tool")
        expect(results.map((m) => [m.name, m.tool_call_id, m.tool_status, m.status])).toEqual([
          ["soft", "call_soft", "error", "completed"],
          ["boom", "call_boom", "error", "completed"],
          ["reject", "call_reject", "error", "completed"],
          ["weird", "call_weird", "error", "completed"],
          ["fine", "call_fine", "success", "completed"],
        ])
        expect(results.map((m) => m.content)).toEqual([
          "soft fail",
          "Tool boom threw: kaboom",
          "Tool reject threw: rejected",
          'Tool weird threw: {"reason":42}',
          "fine",
        ])
      })
      const followUp = history(provider.requests[1]).filter((message) => message.role === "tool")
      expect(followUp.map((m) => (m.role === "tool" ? [m.toolCallId, m.toolName, typeof m.content] : []))).toEqual([
        ["call_soft", "soft", "object"],
        ["call_boom", "boom", "object"],
        ["call_reject", "reject", "object"],
        ["call_weird", "weird", "object"],
        ["call_fine", "fine", "string"],
      ])
      expect(followUp[0]?.role === "tool" ? followUp[0].content : undefined).toEqual({
        type: "error",
        error: "soft fail",
      })
    },
  },
  {
    name: "S14b stores a tool error that keeps the tool's text for a result that cannot be stored, and runs the next call",
    requirements: ["732b2d4b"],
    run: async (driver) => {
      const tools = {
        tangled: defineTool({
          description: "Returns circular diagnostic data",
          execute: async () => {
            const data: Record<string, unknown> = {}
            data.self = data
            return { status: "error" as const, error: "tangled", error_code: "loop", error_data: data }
          },
        }),
        hollow: defineTool({
          description: "Returns a null attachment",
          execute: async () => ({ status: "success" as const, result: "partial", attachments: [null] }) as never,
        }),
        guarded: defineTool({
          description: "Returns error data whose getter throws",
          execute: async () => ({
            status: "error" as const,
            error: "guarded",
            error_data: {
              get secret() {
                throw new Error("no access")
              },
            },
          }),
        }),
        prickly: defineTool({
          description: "Returns a result whose getter throws",
          execute: async () =>
            ({
              status: "success",
              get result() {
                throw new Error("no result")
              },
            }) as never,
        }),
        thrower: defineTool({
          description: "Throws a plain object",
          execute: async () => {
            throw { reason: "quota", retry: false }
          },
        }),
        fine: defineTool({ description: "Returns at once", execute: async () => ok("fine") }),
      }
      const names = ["tangled", "hollow", "guarded", "prickly", "thrower", "fine"]
      const provider = new ScriptedProvider([
        { toolCalls: names.map((name) => ({ id: `c_${name}`, name, arguments: {} })) },
        { text: "recovered" },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        const outcome = await send(session, thread, "go")
        expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
        const results = (await session.messages(thread)).filter((m) => m.role === "tool")
        expect(
          results.map((m) => [m.tool_call_id, m.name, m.tool_status, m.content, m.attachments, m.metadata]),
        ).toEqual([
          [
            "c_tangled",
            "tangled",
            "error",
            "tangled\n\nSpindle dropped the error data of this result, because the message metadata holds a circular reference at $.error_data.self.self, which JSON cannot represent",
            null,
            { error_code: "loop" },
          ],
          [
            "c_hollow",
            "hollow",
            "error",
            "partial\n\nSpindle dropped 1 attachment that is neither a file reference nor a new file.",
            null,
            {},
          ],
          [
            "c_guarded",
            "guarded",
            "error",
            "guarded\n\nSpindle dropped the error data of this result, because reading it threw: no access",
            null,
            {},
          ],
          ["c_prickly", "prickly", "error", "Reading the result of tool prickly threw: no result", null, {}],
          ["c_thrower", "thrower", "error", 'Tool thrower threw: {"reason":"quota","retry":false}', null, {}],
          ["c_fine", "fine", "success", "fine", null, {}],
        ])
      })
      expect(history(provider.requests[1]).map(sideOf)).toEqual([
        ["user", "go"],
        ["assistant", null, names.map((name) => `c_${name}`)],
        ...names.map((name) => ["tool", `c_${name}`]),
      ])
    },
  },
  {
    name: "S15 accepts every legal ToolResult shape, keeps attachment references, and rejects other returns",
    requirements: ["50d12acc", "1d6d311a", "39260b1a"],
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
      const fresh = { name: "new.png", mimeType: "image/png", data: "iVBORw0KGgo=" }
      const variants: Record<string, unknown> = {
        status_only: { status: "success" },
        error_only: { status: "error" },
        empty: { status: "success", result: "" },
        both: { status: "error", error: "broke", result: "partial" },
        structured: {
          status: "error",
          error: "denied",
          error_code: "quota",
          error_data: { limit: 3 },
          stack: "STACK-SENTINEL",
        },
        no_attachments: { status: "success", result: "none", attachments: [] },
        refs: { status: "success", result: "two files", attachments: [chart, notes] },
        new_file: { status: "success", result: "made one", attachments: [fresh] },
        mixed: { status: "success", result: "mixed", attachments: [chart, fresh] },
        bare_string: "just text",
        array: [1, 2],
        object: { foo: 1 },
        unknown_status: { status: "maybe" },
      }
      const names = Object.keys(variants)
      const tools = {
        shape: defineTool({
          description: "Returns a shape",
          args: z.object({ variant: z.string() }),
          execute: async (_state, { variant }) => variants[variant] as never,
        }),
        inspect: defineTool({
          description: "Invokes shape directly",
          uses: ["shape"] as Array<string>,
          execute: async (state: ThreadState) =>
            ok(
              JSON.stringify(
                await Promise.all(["structured", "refs"].map((variant) => state.invokeTool("shape", { variant }))),
              ),
            ),
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            ...names.map((variant) => ({ id: variant, name: "shape", arguments: { variant } })),
            { id: "inspect", name: "inspect", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        await send(session, thread, "go")
        const results = Object.fromEntries(
          (await session.messages(thread)).filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m]),
        )
        const row = (id: string) => [
          results[id]?.tool_status,
          results[id]?.content,
          results[id]?.attachments,
          results[id]?.metadata,
        ]
        expect(row("status_only")).toEqual(["success", "", null, {}])
        expect(row("error_only")).toEqual(["error", "", null, {}])
        expect(row("empty")).toEqual(["success", "", null, {}])
        expect(row("both")).toEqual(["error", "broke\n\npartial", null, {}])
        expect(row("structured")).toEqual(["error", "denied", null, { error_code: "quota", error_data: { limit: 3 } }])
        expect(row("no_attachments")).toEqual(["success", "none", null, {}])
        expect(row("refs")).toEqual(["success", "two files", [chart, notes], {}])
        for (const id of ["new_file", "mixed"]) {
          expect(results[id]?.tool_status).toBe("error")
          expect(results[id]?.content).toContain("M3")
        }
        for (const id of ["bare_string", "array", "object", "unknown_status"]) {
          expect(results[id]?.tool_status).toBe("error")
          expect(results[id]?.content).toContain("not a ToolResult")
        }
        const structured = history(provider.requests[1]).find((m) => m.role === "tool" && m.toolCallId === "structured")
        expect(structured).toEqual({
          role: "tool",
          toolCallId: "structured",
          toolName: "shape",
          content: { type: "error", error: "denied" },
        })
        expect(JSON.stringify(results.structured)).not.toContain("STACK-SENTINEL")
        expect(JSON.parse(results.inspect?.content ?? "null")).toEqual([variants.structured, variants.refs])
      })
    },
  },
  {
    name: "S16 answers a call to an unoffered or unknown tool with an error result and enforces uses in invokeTool",
    requirements: ["732b2d4b", "dc9a10a7", "a403d2a5", "39260b1a"],
    run: async (driver) => {
      const hidden = counter()
      const asState = (state: unknown) => state as ThreadState
      const tools = {
        visible: defineTool({ description: "Offered", execute: async () => ok("visible ran") }),
        hidden: defineTool({ description: "Not offered", execute: async () => hidden.tick(ok("hidden ran")) }),
        limited: defineTool({
          description: "Uses only visible",
          uses: ["visible"] as Array<string>,
          execute: async (state) => ok(JSON.stringify(await asState(state).invokeTool("hidden", {}))),
        }),
        closed: defineTool({
          description: "Uses nothing",
          uses: [] as Array<string>,
          execute: async (state) => ok(JSON.stringify(await asState(state).invokeTool("visible", {}))),
        }),
        open: defineTool({
          description: "Declares no uses",
          execute: async (state: ThreadState) => ok(JSON.stringify(await state.invokeTool("hidden", {}))),
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c_hidden", name: "hidden", arguments: {} },
            { id: "c_ghost", name: "ghost", arguments: {} },
            { id: "c_visible", name: "visible", arguments: {} },
          ],
        },
        {
          toolCalls: [
            { id: "c_limited", name: "limited", arguments: {} },
            { id: "c_closed", name: "closed", arguments: {} },
            { id: "c_open", name: "open", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      await using(
        driver,
        { provider, tools, prompt: { tools: ["visible", "limited", "closed", "open"] } },
        async (session, thread) => {
          const running = send(session, thread, "go")
          const outcome = await running
          expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 3 })
          const results = Object.fromEntries(
            (await session.messages(thread)).filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m]),
          )
          expect([results.c_hidden?.name, results.c_hidden?.tool_status]).toEqual(["hidden", "error"])
          expect(results.c_hidden?.content).toContain("does not offer")
          expect([results.c_ghost?.name, results.c_ghost?.tool_status]).toEqual(["ghost", "error"])
          expect(results.c_visible?.content).toBe("visible ran")
          expect(JSON.parse(results.c_limited?.content ?? "{}")).toMatchObject({ status: "error" })
          expect(JSON.parse(results.c_limited?.content ?? "{}").error).toContain("uses")
          expect(JSON.parse(results.c_closed?.content ?? "{}")).toMatchObject({ status: "error" })
          expect(JSON.parse(results.c_open?.content ?? "{}")).toEqual({ status: "success", result: "hidden ran" })
        },
      )
      expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual([
        "visible",
        "limited",
        "closed",
        "open",
      ])
      expect(hidden.count).toBe(1)
    },
  },
  {
    name: "S17 stops a turn on a text response without tool calls and only then, unless stopOnResponse is false",
    requirements: ["13b3351a", "47ded442", "7aa29e92"],
    run: async (driver) => {
      const tools = { act: defineTool({ description: "Act", execute: async () => ok("acted") }) }
      const mixed = new ScriptedProvider([
        { text: "Working on it", toolCalls: [{ id: "c1", name: "act", arguments: {} }] },
        { text: "Finished" },
      ])
      await using(driver, { provider: mixed, tools }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({
          status: "idle",
          reason: "stop_on_response",
          steps: 2,
        })
        expect(shape(await session.messages(thread))).toEqual([
          ["user", "go"],
          ["assistant", "Working on it"],
          ["tool", "c1"],
          ["assistant", "Finished"],
        ])
      })
      const text = new ScriptedProvider([{ text: "Hello" }, { text: "never asked" }])
      await using(driver, { provider: text, tools }, async (session, thread) => {
        expect(await send(session, thread, "hi")).toMatchObject({ reason: "stop_on_response", steps: 1 })
      })
      expect(text.requests).toHaveLength(1)
      const chatty = new ScriptedProvider([{ text: "one" }, { text: "two" }, { text: "three" }])
      await using(
        driver,
        { provider: chatty, tools, side: { stopOnResponse: false, maxSteps: 2 } },
        async (session, thread) => {
          expect(await send(session, thread, "hi")).toMatchObject({ reason: "max_side_steps", steps: 2 })
        },
      )
      expect(chatty.requests).toHaveLength(2)
    },
  },
  {
    name: "S18 stops after the step that calls the stop tool, runs every call of that step, and reports the outcome",
    requirements: ["60822bc8", "77195da7", "e70c9393"],
    run: async (driver) => {
      const tools = {
        finish: defineTool({
          description: "Finish",
          args: z.object({ summary: z.string() }),
          execute: async (_state, { summary }) => ok(JSON.stringify({ summary: `${summary}, reported`, extra: 1 })),
        }),
        note: defineTool({ description: "Note", execute: async () => ok("noted") }),
      }
      const first = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c_finish", name: "finish", arguments: { summary: "all done" } },
            { id: "c_note", name: "note", arguments: {} },
          ],
        },
        { text: "never asked" },
      ])
      await using(
        driver,
        { provider: first, tools, side: { stopTool: "finish", stopToolResponseProperty: "summary" } },
        async (session, thread) => {
          const outcome = await send(session, thread, "go")
          expect(outcome).toMatchObject({
            status: "idle",
            reason: "stop_tool",
            steps: 1,
            stopTool: { tool: "finish", callId: "c_finish", status: "success", value: "all done, reported" },
          })
          expect(shape(await session.messages(thread)).slice(2)).toEqual([
            ["tool", "c_finish"],
            ["tool", "c_note"],
          ])
        },
      )
      expect(first.requests).toHaveLength(1)
      const later = new ScriptedProvider([
        { toolCalls: [{ name: "note", arguments: {} }] },
        { toolCalls: [{ name: "finish", arguments: { summary: "second" } }] },
        { text: "never asked" },
      ])
      await using(driver, { provider: later, tools, side: { stopTool: "finish" } }, async (session, thread) => {
        const outcome = await send(session, thread, "go")
        expect(outcome).toMatchObject({ reason: "stop_tool", steps: 2 })
        expect(outcome.stopTool?.value).toBe(JSON.stringify({ summary: "second, reported", extra: 1 }))
      })
      expect(later.requests).toHaveLength(2)
    },
  },
  {
    name: "S18b reads the stop property before redaction, so a secret inside the property name cannot hide it",
    requirements: ["e70c9393"],
    run: async (driver) => {
      const stopWith = async (summary: string) => {
        const tools = {
          finish: defineTool({
            description: "Finish",
            variables: [{ name: "MARK", type: "secret", required: true, description: "A short secret" }],
            execute: async () => ok(JSON.stringify({ summary, count: 2 })),
          }),
        }
        const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_finish", name: "finish", arguments: {} }] }])
        let outcome: RunOutcome | undefined
        let stored: Message | undefined
        await using(
          driver,
          { provider, tools, side: { stopTool: "finish", stopToolResponseProperty: "summary" } },
          async (session, thread) => {
            outcome = await send(session, thread, "go")
            stored = (await session.messages(thread)).find((m) => m.role === "tool")
          },
          { MARK: "sum" },
        )
        return { value: outcome?.stopTool?.value, content: stored?.content }
      }
      expect(await stopWith("valid")).toEqual({ value: "valid", content: '{"[redacted]mary":"valid","count":2}' })
      expect(await stopWith("the sum is 4")).toEqual({
        value: "the [redacted] is 4",
        content: '{"[redacted]mary":"the [redacted] is 4","count":2}',
      })
    },
  },
  {
    name: "S18c reports the stored stop tool status when an attachment is dropped",
    requirements: ["e70c9393"],
    run: async (driver) => {
      const tools = {
        finish: defineTool({
          description: "Finish",
          execute: async () => ({ status: "success", result: '{"summary":"done"}', attachments: [null] }) as never,
        }),
      }
      const provider = new ScriptedProvider([{ toolCalls: [{ name: "finish", arguments: {} }] }])
      await using(
        driver,
        { provider, tools, side: { stopTool: "finish", stopToolResponseProperty: "summary" } },
        async (session, thread) => {
          const outcome = await send(session, thread, "go")
          const stored = (await session.messages(thread)).find((message) => message.role === "tool")
          expect(stored?.tool_status).toBe("error")
          expect(outcome.stopTool).toMatchObject({ status: stored?.tool_status, value: "done" })
        },
      )
    },
  },
  {
    name: "S19 counts maxSteps per side and per turn and exposes the counters to tools",
    requirements: ["d80e4c71", "bc5ba253", "c5ab8a06", "ffcb95d1", "77517ef7", "5c3c3e89", "0700c380", "903da2e2"],
    run: async (driver) => {
      const probes: Array<unknown> = []
      const tools = {
        probe: defineTool({
          description: "Report execution state",
          execute: async (state: ThreadState) => {
            const execution = state.execution
            probes.push([
              execution?.currentSide,
              execution?.promptPath,
              execution?.stepCount,
              execution?.sideAStepCount,
              execution?.sideBStepCount,
            ])
            return ok("probed")
          },
        }),
      }
      const twoCalls = {
        toolCalls: [
          { name: "probe", arguments: {} },
          { name: "probe", arguments: {} },
        ],
      }
      const provider = new ScriptedProvider([twoCalls, twoCalls, twoCalls, twoCalls, twoCalls])
      await using(
        driver,
        { provider, tools, side: { stopOnResponse: false, maxSteps: 3 } },
        async (session, thread) => {
          expect(await send(session, thread, "go")).toMatchObject({
            status: "idle",
            reason: "max_side_steps",
            steps: 3,
          })
          expect((await session.messages(thread)).filter((m) => m.role === "tool")).toHaveLength(6)
        },
      )
      expect(provider.requests).toHaveLength(3)
      expect(probes).toEqual([
        ["a", ["assistant"], 1, 1, 0],
        ["a", ["assistant"], 1, 1, 0],
        ["a", ["assistant"], 2, 2, 0],
        ["a", ["assistant"], 2, 2, 0],
        ["a", ["assistant"], 3, 3, 0],
        ["a", ["assistant"], 3, 3, 0],
      ])
      probes.length = 0
      const reversed = new ScriptedProvider([twoCalls, twoCalls, twoCalls])
      await using(
        driver,
        { provider: reversed, tools, humanOn: "a", side: { stopOnResponse: false, maxSteps: 1 } },
        async (session, thread) => {
          expect(await send(session, thread, "first")).toMatchObject({ reason: "max_side_steps", steps: 1 })
          expect(await send(session, thread, "second")).toMatchObject({ reason: "max_side_steps", steps: 1 })
        },
      )
      expect(reversed.requests).toHaveLength(2)
      expect(probes).toEqual([
        ["b", ["assistant"], 1, 0, 1],
        ["b", ["assistant"], 1, 0, 1],
        ["b", ["assistant"], 1, 0, 1],
        ["b", ["assistant"], 1, 0, 1],
      ])
    },
  },
  {
    name: "S20 evaluates stopTool, then stopOnResponse, then maxSteps when more than one rule matches",
    requirements: ["d80e4c71", "7b5d1f06", "44e51927", "8d9a5b12", "35afe886"],
    run: async (driver) => {
      const tools = {
        finish: defineTool({ description: "Finish", execute: async () => ok("finished") }),
        other: defineTool({ description: "Other", execute: async () => ok("other") }),
      }
      const side = { stopTool: "finish", maxSteps: 1 }
      const toolStop = new ScriptedProvider([{ text: "wrapping up", toolCalls: [{ name: "finish", arguments: {} }] }])
      await using(driver, { provider: toolStop, tools, side }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ reason: "stop_tool", steps: 1 })
      })
      const responseStop = new ScriptedProvider([{ text: "just text" }])
      await using(driver, { provider: responseStop, tools, side }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ reason: "stop_on_response", steps: 1 })
      })
      const limit = new ScriptedProvider([{ text: "", toolCalls: [{ name: "other", arguments: {} }] }])
      await using(driver, { provider: limit, tools, side }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ reason: "max_side_steps", steps: 1 })
      })
    },
  },
  {
    name: "S21 retries a response with no text and no tool call, and fails the run when every retry returns nothing",
    requirements: ["7aa29e92"],
    run: async (driver) => {
      const provider = new ScriptedProvider([
        { text: null },
        { text: "" },
        { text: "   " },
        { reasoning: "thinking only" },
        { text: "real" },
      ])
      await using(driver, { provider }, async (session, thread) => {
        const outcome = await send(session, thread, "go", { retries: 4 })
        expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
        expect(outcome.modelCalls.map((call) => call.rejected !== undefined)).toEqual([true, true, true, true, false])
        expect(shape(await session.messages(thread))).toEqual([
          ["user", "go"],
          ["assistant", "real"],
        ])
      })
      expect(provider.requests).toHaveLength(5)
      const silent = new ScriptedProvider([{ text: null }, { text: "" }, { reasoning: "still nothing" }])
      await using(driver, { provider: silent }, async (session, thread) => {
        const outcome = await send(session, thread, "go", { retries: 2 })
        expect(outcome).toMatchObject({ status: "failed", reason: "step_error", steps: 0 })
        expect(outcome.error?.message).toBe(
          "The model returned nothing, with no text and no tool call, after 3 requests",
        )
        expect(shape(await session.messages(thread))).toEqual([["user", "go"]])
      })
    },
  },
  {
    name: "S22 retries retryable provider errors within the budget and settles failed on the others",
    requirements: ["e50614cd", "8fd04a52", "d3de63cd", "3ff82607", "31f3e684", "fe4cd03b", "bd7788f4"],
    run: async (driver) => {
      const cases = [
        ["rate_limit", 429, true],
        ["server_error", 503, true],
        ["timeout", undefined, true],
        ["auth_error", 401, false],
        ["invalid_request", 400, false],
        ["unknown", undefined, false],
      ] as const
      for (const [code, status, retryable] of cases) {
        const error = new ProviderError("the upstream refused", code, status, 0, {
          origin: "provider:scripted",
          upstream: "upstream-a",
        })
        const provider = new ScriptedProvider([{ reject: error }, { text: "recovered" }])
        await using(driver, { provider }, async (session, thread) => {
          const outcome = await send(session, thread, "go", { retries: 1 })
          expect(outcome.modelCalls[0]?.error).toEqual({
            message: "the upstream refused",
            code,
            ...(status === undefined ? {} : { statusCode: status }),
            origin: "provider:scripted",
            upstream: "upstream-a",
          })
          if (retryable) {
            expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
            expect(provider.requests).toHaveLength(2)
          } else {
            expect(outcome).toMatchObject({ status: "failed", reason: "step_error", steps: 0 })
            expect(outcome.error).toEqual({
              message: "the upstream refused",
              code,
              ...(status === undefined ? {} : { statusCode: status }),
              retryAfter: 0,
              origin: "provider:scripted",
              upstream: "upstream-a",
            })
            expect(provider.requests).toHaveLength(1)
            expect(shape(await session.messages(thread))).toEqual([["user", "go"]])
          }
        })
      }
      const partial: Array<ProviderStreamChunk> = [{ type: "content-delta", delta: "half an ans" }]
      const midStream = new ScriptedProvider([
        { chunks: partial, thenThrow: new ProviderError("dropped", "server_error", 502, 0) },
        { chunks: [...partial, { type: "error", error: "overloaded", code: "rate_limit" }] },
        { text: "recovered" },
      ])
      await using(driver, { provider: midStream }, async (session, thread) => {
        const outcome = await send(session, thread, "go", { retries: 2 })
        expect(outcome).toMatchObject({ status: "idle", steps: 1 })
        expect(outcome.modelCalls.map((call) => call.error?.code)).toEqual(["server_error", "rate_limit", undefined])
        expect(shape(await session.messages(thread))).toEqual([
          ["user", "go"],
          ["assistant", "recovered"],
        ])
      })
      const ran = counter()
      const probe = defineTool({ description: "Counts its runs", execute: async () => ran.tick(ok("ran")) })
      const callChunks: Array<ProviderStreamChunk> = [
        { type: "tool-call-start", id: "cut_1", name: "probe" },
        { type: "tool-call-done", id: "cut_1", arguments: {} },
      ]
      const cut = new ScriptedProvider([{ chunks: callChunks }, { chunks: callChunks }, { text: "after the cut" }])
      await using(driver, { provider: cut, tools: { probe } }, async (session, thread) => {
        const outcome = await send(session, thread, "go", { retries: 2 })
        expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
        expect(outcome.modelCalls.map((call) => call.error?.code)).toEqual(["server_error", "server_error", undefined])
        expect(shape(await session.messages(thread))).toEqual([
          ["user", "go"],
          ["assistant", "after the cut"],
        ])
      })
      expect(ran.count).toBe(0)
      const cutOff = new ScriptedProvider([{ chunks: partial }])
      await using(driver, { provider: cutOff }, async (session, thread) => {
        const outcome = await send(session, thread, "go", { retries: 0 })
        expect(outcome).toMatchObject({ status: "failed", reason: "step_error" })
        expect(outcome.error).toMatchObject({ code: "server_error", message: expect.stringContaining("finish") })
      })
      const native = new ScriptedProvider([
        { reject: new DOMException("The operation timed out.", "TimeoutError") },
        { text: "recovered" },
      ])
      await using(driver, { provider: native }, async (session, thread) => {
        const outcome = await send(session, thread, "go", { retries: 1 })
        expect(outcome).toMatchObject({ status: "idle", steps: 1 })
        expect(outcome.modelCalls[0]?.error?.code).toBe("timeout")
      })
    },
  },
  {
    name: "S23 ignores tool annotations in the request, the validation, the execution, and the result",
    requirements: ["3bb2444c", "e2d0db94", "20a428b9", "cfce7619"],
    run: async (driver) => {
      const runWith = async (annotations: Record<string, unknown> | undefined) => {
        const provider = new ScriptedProvider([
          { toolCalls: [{ id: "c1", name: "echo", arguments: { text: "hi" } }] },
          { toolCalls: [{ id: "c2", name: "echo", arguments: { text: 3 } }] },
          { text: "done" },
        ])
        const tools = {
          echo: defineTool({
            description: "Echo",
            args: z.object({ text: z.string() }),
            ...(annotations === undefined ? {} : { annotations }),
            execute: async (_state, { text }) => ok(text),
          }),
        }
        let stored: Array<unknown> = []
        await using(driver, { provider, tools }, async (session, thread) => {
          await send(session, thread, "go")
          stored = (await session.messages(thread)).map((m) => [m.role, m.content, m.tool_status, m.tool_calls])
        })
        return { requests: JSON.stringify(provider.requests), stored }
      }
      const plain = await runWith(undefined)
      const annotated = await runWith({
        spindle_test: { sentinel: "ANNOTATION-SENTINEL" },
        someone_else: { codemode: { codeArgument: "text" } },
      })
      expect(annotated.requests).toBe(plain.requests)
      expect(annotated.stored).toEqual(plain.stored)
      expect(annotated.requests).not.toContain("ANNOTATION-SENTINEL")
    },
  },
  {
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
          await send(session, thread, "what is in it?")
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
  },
  {
    name: "S26 keeps secrets out of the system prompt and hands them only to the tool that asks",
    requirements: ["5522b650", "d263e879", "b7cd3b54"],
    run: async (driver) => {
      const marker = "SECRET-MARKER-7f3a"
      const instance = { API_TOKEN: marker }
      const interpolating = (variables: PromptDefinition["variables"]) =>
        ({
          prompt: [
            { type: "text", content: "Token: " },
            { type: "env", property: "API_TOKEN" },
          ],
          ...(variables === undefined ? {} : { variables }),
        }) as Partial<PromptDefinition>
      const declaresSecret = {
        reads_token: defineTool({
          description: "Declares the token secret",
          variables: [{ name: "API_TOKEN", type: "secret", required: true, description: "Token" }],
          execute: async () => ok("unused"),
        }),
      }
      const cases: Array<[PromptDefinition["variables"], Tools]> = [
        [[{ name: "API_TOKEN", type: "secret", required: true, description: "Token" }], {}],
        [undefined, {}],
        [[{ name: "API_TOKEN", type: "text", required: true, description: "Token" }], declaresSecret],
      ]
      for (const [variables, tools] of cases) {
        const provider = new ScriptedProvider([{ text: "never" }])
        await using(
          driver,
          { provider, tools, prompt: interpolating(variables) },
          async (session, thread) => {
            const outcome = await send(session, thread, "go")
            expect(outcome).toMatchObject({ status: "failed", reason: "fatal_error" })
            expect(outcome.error?.message).toContain("API_TOKEN")
            expect(outcome.error?.message).toContain("Prompt assistant ")
            expect(outcome.error?.message).not.toContain(marker)
          },
          instance,
        )
        expect(provider.requests).toHaveLength(0)
      }
      const tools = {
        call_api: defineTool({
          description: "Calls an API with the token",
          variables: [{ name: "API_TOKEN", type: "secret", required: true, description: "Token" }],
          execute: async (state: ThreadState) =>
            ok((await state.env("API_TOKEN")) === marker ? "authorized" : "wrong token"),
        }),
        needs_missing: defineTool({
          description: "Needs a variable nobody set",
          variables: [{ name: "MISSING_TOKEN", type: "secret", required: true, description: "Token" }],
          execute: async () => ok("should not run"),
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { name: "call_api", arguments: {} },
            { name: "needs_missing", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      await using(
        driver,
        {
          provider,
          tools,
          prompt: {
            prompt: [
              { type: "text", content: "Label: " },
              { type: "env", property: "LABEL" },
            ],
            variables: [{ name: "LABEL", type: "text", required: true, description: "Label" }],
            env: { LABEL: "shown" },
          } as Partial<PromptDefinition>,
        },
        async (session, thread) => {
          await send(session, thread, "go")
          const stored = await session.messages(thread)
          expect(stored.filter((m) => m.role === "tool").map((m) => [m.tool_status, m.content])).toEqual([
            ["success", "authorized"],
            ["error", expect.stringContaining("MISSING_TOKEN")],
          ])
          expect(holding(stored, marker)).toEqual([])
        },
        instance,
      )
      expect(provider.requests[0]?.messages[0]).toEqual({ role: "system", content: "Label: shown" })
      expect(holding(provider.requests, marker)).toEqual([])
    },
  },
  {
    name: "S26d fails before any request when a secret variable or a secret value reaches the finished system prompt",
    requirements: ["d263e879"],
    run: async (driver) => {
      const marker = "SECRET-MARKER-9c2e"
      const declaresSecret = {
        reads_token: defineTool({
          description: "Declares the token secret",
          variables: [{ name: "API_TOKEN", type: "secret", required: true, description: "Token" }],
          execute: async () => ok("unused"),
        }),
      }
      const keyed = new ScriptedProvider([{ text: "never" }])
      const cases: Array<[string, Setup, RegExp]> = [
        [
          "a tool entry gives the secret variable another value",
          {
            provider: new ScriptedProvider([{ text: "never" }]),
            tools: declaresSecret,
            prompt: {
              prompt: [
                { type: "text", content: "Token: " },
                { type: "env", property: "API_TOKEN" },
              ],
              variables: [{ name: "API_TOKEN", type: "text", required: true, description: "Token" }],
              tools: [{ name: "reads_token", env: { API_TOKEN: "decoy" } }],
            } as Partial<PromptDefinition>,
          },
          /^Prompt assistant interpolates variable API_TOKEN, which a declaration or the provider config marks secret/,
        ],
        [
          "an included prompt holds the secret value as text",
          {
            provider: new ScriptedProvider([{ text: "never" }]),
            tools: declaresSecret,
            prompt: { prompt: [{ type: "include", prompt: "house" }] } as Partial<PromptDefinition>,
            prompts: [
              definePrompt({
                name: "house",
                toolDescription: "House rules",
                model: "scripted",
                prompt: `Use ${marker}.`,
              }),
            ],
          },
          /^The system prompt that prompt assistant renders holds a secret value/,
        ],
        [
          "the provider config reads the variable as a secret and the agent gives it a value",
          {
            provider: keyed,
            model: {
              provider: defineProvider({
                name: "keyed_script",
                baseProvider: keyed.factory,
                config: { apiKey: providerEnv("SERVICE_KEY", { valueType: "secret" }) },
              }),
            },
            agent: { env: { SERVICE_KEY: "agent-value" } },
            prompt: {
              prompt: [{ type: "env", property: "SERVICE_KEY" }],
              variables: [{ name: "SERVICE_KEY", type: "text", required: true, description: "Key" }],
            } as Partial<PromptDefinition>,
          },
          /^Prompt assistant interpolates variable SERVICE_KEY, which a declaration or the provider config marks secret/,
        ],
      ]
      for (const [label, setup, message] of cases) {
        await using(
          driver,
          setup,
          async (session, thread) => {
            const outcome = await send(session, thread, "go")
            expect([label, outcome.status, outcome.reason, outcome.error?.message]).toEqual([
              label,
              "failed",
              "fatal_error",
              expect.stringMatching(message),
            ])
            expect(outcome.error?.message).not.toContain(marker)
          },
          { API_TOKEN: marker, SERVICE_KEY: marker },
        )
        expect([label, setup.provider.requests.length]).toEqual([label, 0])
      }
    },
  },
  {
    name: "S26e treats every instance value as secret, so a text variable from the instance never reaches the system prompt",
    requirements: [],
    run: async (driver) => {
      const instance = { DISPLAY: "DISPLAY-TEST-449", REGION: "region-test-731", ZONE: "zone-test-562" }
      const display = new ScriptedProvider([{ text: "never" }])
      await using(
        driver,
        {
          provider: display,
          prompt: {
            prompt: [
              { type: "text", content: "Shown on " },
              { type: "env", property: "DISPLAY" },
            ],
            variables: [{ name: "DISPLAY", type: "text", required: false, description: "Where the answer is shown" }],
          } as Partial<PromptDefinition>,
        },
        async (session, thread) => {
          const outcome = await send(session, thread, "go")
          expect([outcome.status, outcome.reason]).toEqual(["failed", "fatal_error"])
          expect(outcome.error?.message).toMatch(
            /^Prompt assistant interpolates variable DISPLAY, whose value comes from/,
          )
          expect(holding(outcome, instance.DISPLAY)).toEqual([])
        },
        instance,
      )
      expect(display.requests).toHaveLength(0)
      const region = new ScriptedProvider([{ text: "never" }])
      await using(
        driver,
        {
          provider: region,
          tools: {
            locate: defineTool({
              description: "Reads the region as text",
              variables: [{ name: "REGION", type: "text", required: false, description: "The region" }],
              execute: async () => ok("unused"),
            }),
          },
          prompt: { prompt: `Serve ${instance.REGION} only.` },
        },
        async (session, thread) => {
          const outcome = await send(session, thread, "go")
          expect(outcome.error?.message).toMatch(
            /^The system prompt that prompt assistant renders holds a secret value/,
          )
        },
        instance,
      )
      expect(region.requests).toHaveLength(0)
      const zone = new ScriptedProvider([{ toolCalls: [{ name: "zone", arguments: {} }] }, { text: "never" }])
      await using(
        driver,
        {
          provider: zone,
          tools: {
            zone: defineTool({
              description: "Reads an instance value nothing declares",
              execute: async (state: ThreadState) => ok(`read ${await state.instanceEnv?.("ZONE")}`),
            }),
          },
          prompt: { prompt: `Serve ${instance.ZONE} only.` },
        },
        async (session, thread) => {
          const outcome = await send(session, thread, "go")
          expect([outcome.reason, outcome.steps]).toEqual(["fatal_error", 1])
          expect(outcome.error?.message).toMatch(
            /^The system prompt that prompt assistant renders holds a secret value/,
          )
        },
        instance,
      )
      expect(zone.requests).toHaveLength(1)
    },
  },
  {
    name: "S26f redacts the text a tool writes into the thread and keeps what the human and the model wrote",
    requirements: [],
    run: async (driver) => {
      const marker = "INJECT-MARKER-3d1"
      const written: Array<Message> = []
      const tools = {
        scribe: defineTool({
          description: "Writes into the thread",
          variables: [{ name: "MARK", type: "secret", required: true, description: "A secret" }],
          execute: async (state: ThreadState) => {
            const mark = await state.env("MARK")
            written.push(
              await state.injectMessage({ role: "user", content: `injected ${mark}`, metadata: { note: mark } }),
            )
            const blank = await state.injectMessage({ role: "user", content: "blank" })
            written.push(await state.updateMessage(blank.id, { content: `edited ${mark}`, metadata: { by: mark } }))
            return ok("written")
          },
        }),
      }
      const provider = new ScriptedProvider([
        { text: `calling ${marker}`, toolCalls: [{ name: "scribe", arguments: {} }] },
        { text: "done" },
      ])
      await using(
        driver,
        { provider, tools },
        async (session, thread) => {
          await send(session, thread, `hello ${marker}`)
          const stored = await session.messages(thread)
          expect(stored.map((m) => [m.role, m.content])).toEqual([
            ["user", `hello ${marker}`],
            ["assistant", `calling ${marker}`],
            ["user", "injected [redacted]"],
            ["user", "edited [redacted]"],
            ["tool", "written"],
            ["assistant", "done"],
          ])
          expect(stored.filter((m) => m.role === "user").map((m) => m.metadata)).toEqual([
            {},
            { note: "[redacted]" },
            { by: "[redacted]" },
          ])
        },
        { MARK: marker },
      )
      expect(written.map((m) => m.content)).toEqual(["injected [redacted]", "edited [redacted]"])
      expect(history(provider.requests[1]).map((m) => m.content)).toEqual([
        `hello ${marker}`,
        `calling ${marker}`,
        "injected [redacted]",
        "edited [redacted]",
        "written",
      ])
    },
  },
  {
    name: "S26g replaces a secret wherever a tool writes it, in property names and in nested JSON text alike",
    requirements: [],
    run: async (driver) => {
      const marker = "nested-821"
      const tools = {
        nest: defineTool({
          description: "Hides its secret in JSON-looking strings",
          variables: [{ name: "MARK", type: "secret", required: true, description: "A secret" }],
          execute: async (state: ThreadState) => {
            const mark = await state.env("MARK")
            return {
              status: "error" as const,
              error: "sample",
              result: JSON.stringify({ [mark]: mark }),
              error_data: { label: JSON.stringify({ [mark]: 7 }), list: [`[${JSON.stringify(mark)}]`], [mark]: 1 },
              attachments: [
                {
                  type: "file" as const,
                  id: "doc",
                  path: "/doc",
                  mimeType: "text/plain",
                  size: 4,
                  name: JSON.stringify({ [mark]: true }),
                  description: mark,
                },
              ],
            }
          },
        }),
      }
      const provider = new ScriptedProvider([{ toolCalls: [{ name: "nest", arguments: {} }] }, { text: "done" }])
      await using(
        driver,
        { provider, tools },
        async (session, thread) => {
          await send(session, thread, "go")
          const result = (await session.messages(thread)).find((m) => m.role === "tool")
          expect([result?.content, result?.metadata, result?.attachments]).toEqual([
            'sample\n\n{"[redacted]":"[redacted]"}',
            { error_data: { label: '{"[redacted]":7}', list: ['["[redacted]"]'], "[redacted]": 1 } },
            [
              {
                type: "file",
                id: "doc",
                path: "/doc",
                mimeType: "text/plain",
                size: 4,
                name: '{"[redacted]":true}',
                description: "[redacted]",
              },
            ],
          ])
          expect(holding(await session.messages(thread), marker)).toEqual([])
        },
        { MARK: marker },
      )
      expect(holding(provider.requests, marker)).toEqual([])
    },
  },
  {
    name: "S26h redacts a stored result after Spindle adds its own note, so a secret that is a word of the note is removed",
    requirements: [],
    run: async (driver) => {
      const tools = {
        fresh: defineTool({
          description: "Returns a new file",
          variables: [{ name: "MARK", type: "secret", required: true, description: "A secret that is a common word" }],
          execute: async () => ({
            status: "success" as const,
            result: "ok",
            attachments: [{ name: "a.txt", mimeType: "text/plain", data: "Ynl0ZXM=" }],
          }),
        }),
      }
      const provider = new ScriptedProvider([{ toolCalls: [{ name: "fresh", arguments: {} }] }, { text: "done" }])
      await using(
        driver,
        { provider, tools },
        async (session, thread) => {
          await send(session, thread, "go")
          const result = (await session.messages(thread)).find((m) => m.role === "tool")
          expect([result?.tool_status, result?.content]).toEqual([
            "error",
            "ok\n\n[redacted] dropped the new file a.txt, because this version cannot store a new file. The thread file system arrives in M3.",
          ])
        },
        { MARK: "Spindle" },
      )
      expect(holding(provider.requests, "Spindle")).toEqual([])
    },
  },
  {
    name: "S26i redacts a secret that a tool or a hook writes as a property name, in a result, an injection, and an edit",
    requirements: [],
    run: async (driver) => {
      const mark = "sk-fake-0123456789abcdef"
      const keyed = (n: number) => JSON.stringify({ [mark]: n })
      const variables = [{ name: "MARK", type: "secret" as const, required: true, description: "A secret" }]
      let injected = false
      const hooks = [
        defineHook({
          hook: "filter_messages",
          id: "inject_keyed",
          execute: async (state, messages) => {
            if (!injected) {
              injected = true
              const secret = await state.env("MARK")
              await state.injectMessage({ role: "user", content: keyed(1), metadata: { [secret]: "hook" } })
            }
            return messages
          },
        }),
        defineHook({
          hook: "before_update_message",
          id: "edit_keyed",
          execute: async (_state, _id, updates) =>
            updates.content === "for the hook" ? { ...updates, content: keyed(2) } : updates,
        }),
      ]
      const tools = {
        keyed: defineTool({
          description: "Writes its secret as a property name",
          variables,
          execute: async (state: ThreadState) => {
            const secret = await state.env("MARK")
            await state.injectMessage({ role: "user", content: keyed(3), metadata: { [secret]: "tool" } })
            const first = await state.injectMessage({ role: "user", content: "blank" })
            await state.updateMessage(first.id, { content: keyed(4) })
            const second = await state.injectMessage({ role: "user", content: "blank" })
            await state.updateMessage(second.id, { content: "for the hook" })
            return ok(JSON.stringify({ [secret]: true }))
          },
        }),
      }
      const provider = new ScriptedProvider([{ toolCalls: [{ name: "keyed", arguments: {} }] }, { text: "done" }])
      await using(
        driver,
        { provider, tools, hooks, prompt: { variables, hooks: ["inject_keyed", "edit_keyed"] } },
        async (session, thread) => {
          await send(session, thread, "go")
          const stored = await session.messages(thread)
          expect(stored.map((m) => [m.role, m.content, m.metadata])).toEqual([
            ["user", "go", {}],
            ["user", '{"[redacted]":1}', { "[redacted]": "hook" }],
            ["assistant", null, {}],
            ["user", '{"[redacted]":3}', { "[redacted]": "tool" }],
            ["user", '{"[redacted]":4}', {}],
            ["user", '{"[redacted]":2}', {}],
            ["tool", '{"[redacted]":true}', {}],
            ["assistant", "done", {}],
          ])
          expect(holding(stored, mark)).toEqual([])
        },
        { MARK: mark },
      )
      expect(holding(provider.requests, mark)).toEqual([])
    },
  },
  {
    name: "S26b redacts a secret of any length from stored tool results, later requests, and run errors",
    requirements: ["287f2aef"],
    run: async (driver) => {
      const instance = { SHORT_TOKEN: "Q7z", QUOTED_TOKEN: 'a"b\\c' }
      const tools = {
        reveal: defineTool({
          description: "Returns its tokens",
          variables: [
            { name: "SHORT_TOKEN", type: "secret", required: true, description: "A short token" },
            { name: "QUOTED_TOKEN", type: "secret", required: true, description: "A token with JSON escapes" },
          ],
          execute: async (state: ThreadState) => ({
            status: "error",
            error: `short ${await state.env("SHORT_TOKEN")}`,
            error_code: "denied",
            error_data: { quoted: await state.env("QUOTED_TOKEN"), nested: ["Q7z"], count: 7 },
          }),
        }),
        attach: defineTool({
          description: "Returns a new file named after its token",
          variables: [{ name: "SHORT_TOKEN", type: "secret", required: true, description: "A short token" }],
          execute: async (state: ThreadState) => ({
            status: "success",
            attachments: [
              { name: `report ${await state.env("SHORT_TOKEN")}.txt`, mimeType: "text/plain", data: "YQ==" },
            ],
          }),
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { name: "reveal", arguments: {} },
            { name: "attach", arguments: {} },
          ],
        },
        { reject: new ProviderError('upstream echoed Q7z and a"b\\c', "invalid_request") },
      ])
      await using(
        driver,
        { provider, tools },
        async (session, thread) => {
          const outcome = await send(session, thread, "go")
          expect(outcome.error?.message).toBe("upstream echoed [redacted] and [redacted]")
          const stored = await session.messages(thread)
          const result = stored.find((m) => m.role === "tool")
          expect([result?.content, result?.metadata]).toEqual([
            "short [redacted]",
            { error_code: "denied", error_data: { quoted: "[redacted]", nested: ["[redacted]"], count: 7 } },
          ])
          for (const secret of Object.values(instance))
            expect(holding([stored, provider.requests, outcome], secret)).toEqual([])
        },
        instance,
      )
      const tiny = {
        status: defineTool({
          description: "Returns a one-character secret in its data",
          variables: [{ name: "ONE_CHAR", type: "secret", required: true, description: "A one-character token" }],
          execute: async (state: ThreadState) => {
            const token = await state.env("ONE_CHAR")
            return { status: "error" as const, error: "rejected", error_data: { [`key ${token}`]: "kept" } }
          },
        }),
      }
      const statusCheck = new ScriptedProvider([{ toolCalls: [{ name: "status", arguments: {} }] }, { text: "done" }])
      await using(
        driver,
        { provider: statusCheck, tools: tiny, prompt: { prompt: "Act now." } },
        async (session, thread) => {
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response" })
          const result = (await session.messages(thread)).find((m) => m.role === "tool")
          expect([result?.tool_status, result?.content, result?.metadata]).toEqual([
            "error",
            "r[redacted]j[redacted]ct[redacted]d",
            { error_data: { "k[redacted]y [redacted]": "k[redacted]pt" } },
          ])
        },
        { ONE_CHAR: "e" },
      )
    },
  },
  {
    name: "S26c stores the model's reply as returned and runs the tool with the arguments it stored",
    requirements: [],
    run: async (driver) => {
      let received: unknown
      const tools = {
        check: defineTool({
          description: "Records its arguments",
          variables: [{ name: "SHORT_TOKEN", type: "secret", required: true, description: "A short token" }],
          args: z.object({ label: z.string() }),
          execute: async (_state, args) => {
            received = args
            return ok("checked")
          },
        }),
      }
      const echoing = new ScriptedProvider([
        {
          text: "the sum is 4",
          reasoning: "it said sum",
          toolCalls: [{ id: "e1", name: "check", arguments: { label: "sum of parts" } }],
        },
        { text: "done" },
      ])
      await using(
        driver,
        { provider: echoing, tools },
        async (session, thread) => {
          await send(session, thread, "go")
          const model = (await session.messages(thread)).find((m) => m.role === "assistant")
          expect([model?.content, model?.reasoning_content, callsOf(model)]).toEqual([
            "the sum is 4",
            "it said sum",
            [{ id: "e1", type: "function", function: { name: "check", arguments: '{"label":"sum of parts"}' } }],
          ])
        },
        { SHORT_TOKEN: "sum" },
      )
      expect(received).toEqual({ label: "sum of parts" })
      expect(history(echoing.requests[1]).find((m) => m.role === "assistant")).toEqual({
        role: "assistant",
        content: "the sum is 4",
        reasoning: "it said sum",
        toolCalls: [{ id: "e1", name: "check", arguments: { label: "sum of parts" } }],
      })
    },
  },
  {
    name: "S36 builds a createFetch transport for every backend request, a retry included",
    requirements: ["34cea831"],
    run: async (driver) => {
      const log: Array<string> = []
      let builds = 0
      const base: ProviderFactoryWithOptions = (config) => ({
        name: "transported",
        specificationVersion: "1",
        generate: async () => {
          throw new Error("unused")
        },
        stream: async () => {
          const response = await config.fetch?.("http://backend.test/v1", {})
          if (response?.status === 429) throw new ProviderError("slow down", "rate_limit", 429, 0)
          return (async function* (): AsyncGenerator<ProviderStreamChunk> {
            yield { type: "content-delta", delta: "after the retry" }
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            }
          })()
        },
      })
      const extension = defineProvider({
        name: "per_request",
        baseProvider: base,
        createFetch: () => {
          builds += 1
          const transport = builds
          log.push(`build ${transport}`)
          return async () => {
            log.push(`send ${transport}`)
            return new Response("", { status: log.length < 3 ? 429 : 200 })
          }
        },
      })
      const provider = new ScriptedProvider([])
      await using(driver, { provider, model: { provider: extension } }, async (session, thread) => {
        const outcome = await send(session, thread, "go")
        expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      })
      expect(log).toEqual(["build 1", "send 1", "build 2", "send 2"])
    },
  },
  {
    name: "S27 treats provider-executed tools and generated images as parts of one response and runs nothing locally",
    requirements: [],
    run: async (driver) => {
      const local = counter()
      const tools = {
        web_search: defineTool({ description: "Local search", execute: async () => local.tick(ok("local")) }),
      }
      const image = (index: number) => ({
        type: "image-done" as const,
        index,
        image: { data: "iVBORw0KGgo=", mediaType: "image/png" },
      })
      const provider = new ScriptedProvider([
        {
          chunks: [
            { type: "content-delta", delta: "Here is what I found" },
            { type: "provider-tool-done", tool: { name: "web_search", id: "ws_1", status: "completed" } },
            { type: "web-search-done", result: { id: "ws_2", status: "completed" } },
            image(1),
            image(0),
            image(1),
            { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
          ],
        },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        const outcome = await send(session, thread, "search")
        expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
        expect(outcome.modelCalls[0]).toMatchObject({ images: 2, providerTools: 2 })
        expect(shape(await session.messages(thread))).toEqual([
          ["user", "search"],
          ["assistant", "Here is what I found"],
        ])
      })
      expect(local.count).toBe(0)
    },
  },
  {
    name: "S28 gives a tool a ThreadState with the thread's identity, one execution context, and live execution state",
    requirements: ["bb21b13f", "afa3f93e", "ac0df6bc", "bc63a67f", "7b26e7c9", "e6e64d26", "31e057f3", "09150a13"],
    run: async (driver) => {
      const seen: Array<Record<string, unknown>> = []
      const tools = {
        first: defineTool({
          description: "First",
          execute: async (state: ThreadState) => {
            state.context.shared = "from first"
            seen.push({
              threadId: state.threadId,
              agentId: state.agentId,
              userId: state.userId,
              createdAt: state.createdAt,
              terminated: state.terminated,
              arguments: state.arguments,
              execution: state.execution === null ? null : typeof state.execution.flowId,
            })
            return ok("first")
          },
        }),
        second: defineTool({
          description: "Second",
          execute: async (state: ThreadState) => {
            seen.push({ shared: state.context.shared, flowId: state.execution?.flowId, created: state.createdAt })
            return ok("second")
          },
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { name: "first", arguments: {} },
            { name: "second", arguments: {} },
          ],
        },
        { toolCalls: [{ name: "second", arguments: {} }] },
        { text: "done" },
        { toolCalls: [{ name: "second", arguments: {} }] },
        { text: "done again" },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        const sentAt = Date.now() * 1000
        await send(session, thread, "go")
        const { createdAt, ...identity } = seen[0] ?? {}
        expect(identity).toEqual({
          threadId: thread,
          agentId: "assistant",
          userId: null,
          terminated: null,
          arguments: {},
          execution: "string",
        })
        const firstMessage = (await session.messages(thread))[0]
        expect(Number.isInteger(createdAt)).toBe(true)
        expect(createdAt as number).toBeLessThanOrEqual(firstMessage?.created_at ?? 0)
        expect(sentAt - (createdAt as number)).toBeLessThan(60_000_000)
        expect(seen[1]?.shared).toBe("from first")
        expect(seen[2]?.shared).toBe("from first")
        expect(seen[1]?.flowId).toBe(seen[2]?.flowId)
        expect(await send(session, thread, "again")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        expect(seen[3]?.shared).toBeUndefined()
        expect(seen[3]?.flowId).not.toBe(seen[2]?.flowId)
        expect(seen[3]?.created).toBe(createdAt)
      })
    },
  },
  {
    name: "S29 loads definitions and lists their names through ThreadState",
    requirements: ["52e1e778", "c4b75828", "e3afb48b", "4d4c50a2", "cf66e53e", "be6b8ba1", "75fba4a7"],
    run: async (driver) => {
      let report: Record<string, unknown> = {}
      const tools = {
        survey: defineTool({
          description: "Survey",
          execute: async (state: ThreadState) => {
            const model = await state.loadModel<{ model: string }>("scripted")
            const prompt = await state.loadPrompt<{ name: string }>("assistant")
            const agent = await state.loadAgent<{ name: string }>("assistant")
            const rejected = (load: Promise<unknown>) =>
              load.then(
                () => "resolved",
                (error: Error) => error.message,
              )
            report = {
              model: model.model,
              prompt: prompt.name,
              agent: agent.name,
              prompts: state.getPromptNames(),
              agents: state.getAgentNames(),
              models: state.getModelNames(),
              missing: [
                await rejected(state.loadModel("absent")),
                await rejected(state.loadPrompt("absent")),
                await rejected(state.loadAgent("absent")),
              ],
            }
            return ok("surveyed")
          },
        }),
      }
      const provider = new ScriptedProvider([{ toolCalls: [{ name: "survey", arguments: {} }] }, { text: "done" }])
      const other = new ScriptedProvider([])
      const extra = {
        prompts: [
          definePrompt({ name: "second", toolDescription: "Second", model: "second_model", prompt: "Second." }),
        ],
        models: [defineModel({ name: "second_model", provider: other.factory, model: "second-model-v1" })],
        agents: [defineAgent({ name: "second_agent", sideA: { prompt: "second" }, sideB: { human: true } })],
      }
      await using(driver, { provider, tools, ...extra }, async (session, thread) => {
        await send(session, thread, "go")
      })
      expect(report).toEqual({
        model: "scripted-model-v1",
        prompt: "assistant",
        agent: "assistant",
        prompts: ["assistant", "second"],
        agents: ["assistant", "second_agent"],
        models: ["scripted", "second_model"],
        missing: [
          "No model named absent is defined",
          "No prompt named absent is defined",
          "No agent named absent is defined",
        ],
      })
    },
  },
  {
    name: "S30 makes an injected message durable at once, visible to the next tool, and eligible from the next assembly",
    requirements: ["8cefb16e", "b74ef581", "73bce32e", "c4905fe6", "6638d0e6"],
    run: async (driver) => {
      const seen: Array<unknown> = []
      const tools = {
        inject: defineTool({
          description: "Inject a note",
          execute: async (state: ThreadState) => {
            const message = await state.injectMessage({
              role: "user",
              content: "note from a tool",
              silent: true,
              metadata: { source: "tool" },
            })
            const read = await state.getMessage(message.id)
            const listed = await state.getMessages({ order: "asc", includeSilent: true })
            seen.push([message.silent, read?.content, read?.metadata, listed.messages.at(-1)?.id === message.id])
            await state.injectMessage({ role: "system", content: "system note" })
            return ok("injected")
          },
        }),
        observe: defineTool({
          description: "Look at the live history",
          execute: async (state: ThreadState) => {
            const history = state.execution?.messageHistory ?? []
            seen.push(history.map((message) => message.content))
            history.pop()
            return ok("observed")
          },
        }),
        check: defineTool({
          description: "Check the live history again",
          execute: async (state: ThreadState) => {
            seen.push((state.execution?.messageHistory ?? []).length)
            return ok("checked")
          },
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c_inject", name: "inject", arguments: {} },
            { id: "c_observe", name: "observe", arguments: {} },
            { id: "c_check", name: "check", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        expect((await session.messages(thread)).map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "user",
          "system",
          "tool",
          "tool",
          "tool",
          "assistant",
        ])
      })
      expect(seen).toEqual([
        [true, "note from a tool", { source: "tool" }, true],
        ["go", null, "note from a tool", "system note", "injected"],
        6,
      ])
      expect(provider.requests).toHaveLength(2)
      expect(JSON.stringify(provider.requests[0])).not.toContain("note from a tool")
      expect(history(provider.requests[1]).map(sideOf)).toEqual([
        ["user", "go"],
        ["assistant", null, ["c_inject", "c_observe", "c_check"]],
        ["user", "note from a tool"],
        ["tool", "c_inject"],
        ["tool", "c_observe"],
        ["tool", "c_check"],
      ])
      expect(provider.requests[1]?.messages.filter((m) => m.role === "system").map((m) => m.content)).toEqual([
        "You are a test assistant.",
        "system note",
      ])
    },
  },
  {
    name: "S31 gives tools execution state with a flow id per execution, the root prompt path, and an abort signal",
    requirements: ["04d1538b", "8a66bc04", "6ad6d3c1", "18655cf1", "6f984718", "903da2e2", "c544edac"],
    run: async (driver) => {
      const seen: Array<unknown> = []
      const tools = {
        probe: defineTool({
          description: "Probe",
          execute: async (state: ThreadState) => {
            const execution = state.execution
            seen.push([
              execution?.flowId,
              execution?.promptPath,
              execution?.abortSignal instanceof AbortSignal,
              execution?.abortSignal.aborted,
              execution?.messageHistory.map((message) => [message.role, message.content, message.silent]),
            ])
            return ok("probed")
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: "probe", arguments: {} }] },
        { toolCalls: [{ name: "probe", arguments: {} }] },
        { text: "first done" },
        { toolCalls: [{ name: "probe", arguments: {} }] },
        { text: "second done" },
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        await session.seed(thread, [{ role: "user", content: "quiet", silent: true }])
        await send(session, thread, "first")
        await send(session, thread, "second")
      })
      const flows = seen.map((entry) => (entry as Array<unknown>)[0])
      expect(typeof flows[0]).toBe("string")
      expect(flows[0]).toBe(flows[1])
      expect(flows[2]).not.toBe(flows[0])
      const first = [
        ["user", "quiet", true],
        ["user", "first", false],
        ["assistant", null, false],
      ]
      const second = [...first, ["tool", "probed", false], ["assistant", null, false]]
      const third = [
        ...second,
        ["tool", "probed", false],
        ["assistant", "first done", false],
        ["user", "second", false],
        ["assistant", null, false],
      ]
      expect(seen.map((entry) => (entry as Array<unknown>).slice(1))).toEqual([
        [["assistant"], true, false, first],
        [["assistant"], true, false, second],
        [["assistant"], true, false, third],
      ])
    },
  },
  {
    name: "S32 resolves env by agent, tool entry, prompt, then instance, classifies it secret, and invokes a listed tool",
    requirements: ["5522b650", "7553bb50", "287f2aef", "d6567ce8", "07a378de", "341727f4", "a01f5667"],
    run: async (driver) => {
      let report: Record<string, unknown> = {}
      const tools = {
        helper: defineTool({
          description: "Helper",
          args: z.object({ n: z.number() }),
          execute: async (_state, { n }) => ok(String(n * 2)),
        }),
        survey: defineTool({
          description: "Survey",
          uses: ["helper"] as Array<string>,
          execute: async (state: ThreadState) => {
            report = {
              region: await state.env("REGION"),
              level: await state.env("LEVEL"),
              source: await state.env("SOURCE"),
              type: await state.envType("REGION"),
              missing: await state.env("NOPE").then(
                () => "resolved",
                () => "rejected",
              ),
              invoked: await state.invokeTool("helper", { n: 21 }),
              invalid: await state.invokeTool("helper", { n: "x" }),
            }
            return ok("surveyed")
          },
        }),
        other: defineTool({
          description: "Another tool",
          execute: async (state: ThreadState) => ok(`prompt level: ${(await state.env("LEVEL")) === "prompt-level"}`),
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { name: "survey", arguments: {} },
            { id: "c_other", name: "other", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      let otherLevel: string | null | undefined
      await using(
        driver,
        {
          provider,
          tools,
          agent: { env: { REGION: "agent-region" } },
          prompt: {
            env: { REGION: "prompt-region", LEVEL: "prompt-level" },
            variables: [{ name: "LEVEL", type: "text", required: true, description: "Level" }],
            tools: [{ name: "survey", env: { LEVEL: "tool-level" } }, "helper", "other"],
          } as Partial<PromptDefinition>,
        },
        async (session, thread) => {
          await send(session, thread, "go")
          otherLevel = (await session.messages(thread)).find((m) => m.tool_call_id === "c_other")?.content
        },
        { REGION: "instance-region", SOURCE: "instance" },
      )
      expect(report).toMatchObject({
        region: "agent-region",
        level: "tool-level",
        source: "instance",
        type: "secret",
        missing: "rejected",
        invoked: { status: "success", result: "42" },
        invalid: { status: "error" },
      })
      expect(otherLevel).toBe("prompt level: true")
    },
  },
  {
    name: "S32b resolves env() from agent defaults, then prompt defaults, then the instance",
    requirements: ["65b3e24e", "3918859a", "6cd8ba3f"],
    run: async (driver) => {
      let resolved: Array<string> = []
      const tools = {
        read_env: defineTool({
          description: "Reads three variables",
          execute: async (state: ThreadState) => {
            resolved = [
              await state.env("ALL_THREE"),
              await state.env("PROMPT_AND_INSTANCE"),
              await state.env("ONLY_INSTANCE"),
            ]
            return ok("read")
          },
        }),
      }
      const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_env", arguments: {} }] }, { text: "done" }])
      await using(
        driver,
        {
          provider,
          tools,
          agent: { env: { ALL_THREE: "from agent" } },
          prompt: {
            env: { ALL_THREE: "from prompt", PROMPT_AND_INSTANCE: "from prompt" },
          } as Partial<PromptDefinition>,
        },
        async (session, thread) => {
          await send(session, thread, "go")
        },
        { ALL_THREE: "from instance", PROMPT_AND_INSTANCE: "from instance", ONLY_INSTANCE: "from instance" },
      )
      expect(resolved).toEqual(["from agent", "from prompt", "from instance"])
    },
  },
  {
    name: "S33 passes ThreadState message reads, updates, and deletes through to thread storage",
    requirements: ["79171656", "37e69561", "3489685d", "f67424cd", "bd122f30", "7f464a24", "1edbcdb1"],
    run: async (driver) => {
      const seen: Record<string, unknown> = {}
      const tools = {
        reader: defineTool({
          description: "Reads and edits messages",
          execute: async (state: ThreadState) => {
            const contents = (result: { messages: ReadonlyArray<Message> }) => result.messages.map((m) => m.content)
            seen.newest = contents(await state.getMessages({ limit: 2 }))
            seen.paged = contents(await state.getMessages({ order: "asc", limit: 2, offset: 1 }))
            seen.visible = contents(await state.getMessages({ order: "asc" }))
            seen.all = contents(await state.getMessages({ order: "asc", includeSilent: true }))
            seen.shallow = contents(await state.getMessages({ order: "asc", includeSilent: true, maxDepth: 0 }))
            const { messages } = await state.getMessages({ order: "asc", includeSilent: true })
            const old = messages.find((m) => m.content === "old call")
            const updated = await state.updateMessage(messages[0]?.id ?? "", { metadata: { seen: true } })
            seen.updated = updated.metadata
            seen.deleted = [await state.deleteMessage(old?.id ?? ""), await state.deleteMessage(old?.id ?? "")]
            seen.after = contents(await state.getMessages({ order: "asc", includeSilent: true }))
            return ok("read")
          },
        }),
      }
      const provider = new ScriptedProvider([{ toolCalls: [{ name: "reader", arguments: {} }] }, { text: "done" }])
      await using(driver, { provider, tools }, async (session, thread) => {
        await session.seed(thread, [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: "old call",
            tool_calls: JSON.stringify([
              { id: "old", type: "function", function: { name: "reader", arguments: "{}" } },
            ]),
          },
          { role: "tool", content: "old result", name: "reader", tool_call_id: "old", tool_status: "success" },
          { role: "user", content: "quiet", silent: true },
          { role: "assistant", content: "nested", depth: 1 },
        ])
        await send(session, thread, "go")
      })
      expect(seen).toEqual({
        newest: [null, "go"],
        paged: ["old call", "old result"],
        visible: ["first", "old call", "old result", "nested", "go", null],
        all: ["first", "old call", "old result", "quiet", "nested", "go", null],
        shallow: ["first", "old call", "old result", "quiet", "go", null],
        updated: { seen: true },
        deleted: [true, false],
        after: ["first", "quiet", "nested", "go", null],
      })
    },
  },
  {
    name: "S33b deletes a side B model turn together with the tool results of its calls",
    requirements: ["96307380"],
    run: async (driver) => {
      const tools = {
        note: defineTool({ description: "Returns a note", execute: async () => ok("noted") }),
        eraser: defineTool({
          description: "Deletes the model turn that called note",
          execute: async (state: ThreadState) => {
            const { messages } = await state.getMessages({ order: "asc" })
            const turn = messages.find((m) => callsOf(m).some((call) => call.id === "c1"))
            return ok(String(await state.deleteMessage(turn?.id ?? "")))
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "note", arguments: {} }] },
        { toolCalls: [{ id: "c2", name: "eraser", arguments: {} }] },
        { text: "done" },
      ])
      await using(driver, { provider, tools, humanOn: "a" }, async (session, thread) => {
        await send(session, thread, "go")
        const stored = await session.messages(thread)
        expect(stored.map((m) => [m.role, m.role === "tool" ? m.tool_call_id : callsOf(m).map((c) => c.id)])).toEqual([
          ["assistant", []],
          ["user", ["c2"]],
          ["tool", "c2"],
          ["user", []],
        ])
        expect(stored.find((m) => m.tool_call_id === "c2")?.content).toBe("true")
      })
    },
  },
  {
    name: "S34 keeps a tool's key-value writes for later executions of the same thread and only that thread",
    requirements: ["d0bf2dee", "70e01371", "5e2f73a8", "b680018e", "1c6df0f5"],
    run: async (driver) => {
      const tools = {
        remember: defineTool({
          description: "Remember a color",
          args: z.object({ color: z.string() }),
          execute: async (state, { color }) => {
            await state.setValue("color", { color })
            return ok("remembered")
          },
        }),
        recall: defineTool({
          description: "Recall the color",
          execute: async (state: ThreadState) => ok(JSON.stringify(await state.getValue("color"))),
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: "remember", arguments: { color: "teal" } }] },
        { text: "saved" },
        { toolCalls: [{ id: "c_later", name: "recall", arguments: {} }] },
        { text: "recalled" },
        { toolCalls: [{ id: "c_elsewhere", name: "recall", arguments: {} }] },
        { text: "nothing" },
      ])
      const session = await driver.load(project({ provider, tools }))
      try {
        const thread = await session.createThread("assistant")
        await send(session, thread, "remember teal")
        await send(session, thread, "what color?")
        const other = await session.createThread("assistant")
        await send(session, other, "what color?")
        const result = async (id: string, threadId: string) =>
          (await session.messages(threadId)).find((m) => m.tool_call_id === id)?.content
        expect(await result("c_later", thread)).toBe(JSON.stringify({ color: "teal" }))
        expect(await result("c_elsewhere", other)).toBe("null")
      } finally {
        await session.close()
      }
    },
  },
  {
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
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
        ["system", "late note"],
        ["tool", "c1"],
      ])
    },
  },
]
