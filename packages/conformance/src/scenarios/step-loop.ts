import {
  type AgentDefinition,
  defineAgent,
  defineModel,
  definePrompt,
  defineTool,
  type Message,
  type ModelDefinition,
  type PromptDefinition,
  ProviderError,
  type ProviderMessage,
  type ProviderStreamChunk,
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

interface Setup {
  readonly provider: ScriptedProvider
  readonly prompt?: Partial<PromptDefinition>
  readonly prompts?: ReadonlyArray<PromptDefinition>
  readonly side?: Partial<AgentDefinition["sideA"]>
  readonly agent?: Partial<AgentDefinition>
  readonly humanOn?: "a" | "b"
  readonly model?: Partial<ModelDefinition>
  readonly models?: ReadonlyArray<ModelDefinition>
  readonly tools?: Tools
}

const project = (setup: Setup): Project => {
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
    ],
    tools: setup.tools ?? {},
  }
}

const open = async (driver: RuntimeDriver, setup: Setup, instanceEnv?: Record<string, string>) => {
  const session = await driver.load(project(setup), instanceEnv === undefined ? {} : { instanceEnv })
  const thread = await session.createThread("assistant")
  return { session, thread }
}

const using = async (
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

const gate = () => {
  let release: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, opened }
}

const ok = (result: string) => ({ status: "success" as const, result })

const callsOf = (message: Message | undefined) =>
  JSON.parse(message?.tool_calls ?? "[]") as Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>

const shape = (messages: ReadonlyArray<Message>) =>
  messages.map((message) => [message.role, message.role === "tool" ? message.tool_call_id : message.content])

const history = (request: RecordedRequest | undefined) =>
  (request?.messages ?? []).filter((message) => message.role !== "system")

const sideOf = (message: ProviderMessage) =>
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

const send = (session: RuntimeSession, thread: string, text: string, options?: SendOptions): Promise<RunOutcome> =>
  session.send(thread, text, options)

export const stepLoopScenarios: ReadonlyArray<Scenario> = [
  {
    name: "S01 persists the response before any tool and each result before the next tool starts",
    requirements: ["6362a22f", "9e1310ee", "f6fb47da", "7056a090", "c5f07383", "13b3351a", "83735bf6", "43d5659d"],
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
    name: "S02 maps stored perspective to provider roles for a human on either side and hides the other side's calls",
    requirements: ["58bf6a6d", "3b206e78", "43bbb05d", "266d6af4"],
    run: async (driver) => {
      for (const humanOn of ["b", "a"] as const) {
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
          { provider, tools, humanOn, prompt: { includeChat: true, tools: ["lookup"] } },
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
    },
  },
  {
    name: "S03 renders includes in place and resolves variables by precedence before any request",
    requirements: ["97e0539c", "e9cb2058"],
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
      expect((await render(undefined, undefined, { tone: "instance-tone" })).request?.messages[0]?.content).toContain(
        "tone=instance-tone",
      )
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
    requirements: ["a3e64f93", "22a9ddbb", "b93f89a4", "8254ece3", "dca92c64"],
    run: async (driver) => {
      const views: Record<string, unknown> = {}
      for (const [includeChat, includePastTools] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
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
        await using(driver, { provider, tools, prompt: { includeChat, includePastTools } }, async (session, thread) => {
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
    requirements: ["a170a848", "987763cb", "072413a0", "83735bf6", "ec3b4b7f"],
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
    name: "S06 merges provider options model then prompt and carries the reasoning settings with the model's levels",
    requirements: [],
    run: async (driver) => {
      const levels = { 0: "none", 33: "low", 66: "medium", 100: "high" }
      const requestFor = async (prompt: Partial<PromptDefinition>, model: Partial<ModelDefinition>) => {
        const provider = new ScriptedProvider([{ text: "ok" }])
        await using(driver, { provider, prompt, model }, async (session, thread) => {
          await send(session, thread, "hi")
        })
        return provider.requests[0]
      }
      const merged = await requestFor(
        {
          providerOptions: { b: 2, shared: "prompt" },
          reasoning: { level: 57, maxTokens: 512, exclude: true, include: false },
        },
        {
          providerOptions: { a: 1, shared: "model", reasoning_effort: "low" },
          capabilities: { reasoningLevels: levels },
        },
      )
      expect(merged?.providerOptions).toEqual({ a: 1, shared: "prompt", reasoning_effort: "low", b: 2 })
      expect(merged?.reasoning).toEqual({ level: 57, levels, maxTokens: 512, exclude: true })
      const zero = await requestFor({ reasoning: { level: 0 } }, { capabilities: { reasoningLevels: levels } })
      expect(zero?.reasoning).toEqual({ level: 0, levels })
      const unset = await requestFor({ reasoning: { maxTokens: 100 } }, { capabilities: { reasoningLevels: levels } })
      expect(unset?.reasoning).toEqual({ maxTokens: 100 })
      const plain = await requestFor({}, {})
      expect(plain).not.toHaveProperty("reasoning")
      expect(plain).not.toHaveProperty("providerOptions")
    },
  },
  {
    name: "S07 passes toolChoice through, sends none with the definitions, and never runs a call the prompt forbids",
    requirements: ["539cf227", "20479ea7", "975e02f5", "ea4bf54e", "2f53909a"],
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
    requirements: ["6a7975b1", "7abccc72", "c0dc1ab1"],
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
    requirements: ["7abccc72", "80b5ff9b", "b9e3d243", "bbc2f60d", "c0dc1ab1"],
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
      ])
      expect(
        replayed.stored.filter((m) => m.role === "assistant").map((m) => [m.reasoning_content, m.reasoning_details]),
      ).toEqual([
        ["r1", null],
        [null, JSON.stringify([{ type: "text", text: "d2" }])],
        ["r3", JSON.stringify([{ type: "summary", text: "d3" }])],
        [null, null],
        ["ro", JSON.stringify([{ type: "encrypted", data: "foreign" }])],
        [null, null],
      ])
      const withheld = await run({ includeChat: true, reasoning: { include: false } })
      const text = JSON.stringify(withheld.request)
      for (const marker of ['"r1"', '"d2"', '"r3"', '"d3"', '"ro"', "foreign"]) expect(text).not.toContain(marker)
      expect(withheld.stored.filter((m) => m.role === "assistant")[0]?.reasoning_content).toBe("r1")
      const excluded = await run({})
      expect(history(excluded.request).map(sideOf)).toEqual([["user", "q5"]])
      expect(JSON.stringify(excluded.request)).not.toContain("r1")
    },
  },
  {
    name: "S11 fetches response metadata beside the loop and waits for it only before the run settles",
    requirements: ["016dca2f"],
    run: async (driver) => {
      const metadataGate = gate()
      const secondRequest = gate()
      const summaries: Array<ResponseSummary> = []
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
    requirements: ["e2a1037e", "5522b4f9", "2cf0753e"],
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
    requirements: ["732b2d4b"],
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
        expect(callsOf(stored[1]).map((call) => [call.id, call.function.arguments])).toEqual([
          ["broken", '{"q": "unterminated'],
          ["fine", '{"q":"ok"}'],
        ])
        const results = stored.filter((message) => message.role === "tool")
        expect(results.map((m) => [m.tool_call_id, m.name, m.tool_status])).toEqual([
          ["broken", "lookup", "error"],
          ["fine", "lookup", "success"],
        ])
        expect(results[0]?.content).toContain("not a complete JSON object")
      })
      expect(seen).toEqual(["ok"])
    },
  },
  {
    name: "S14 stores every tool outcome as a named, linked result and keeps the loop running",
    requirements: ["968989f2", "41278e5e", "3b0dd02b", "5522b4f9", "2cf0753e", "732b2d4b"],
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
          expect.stringContaining("kaboom"),
          expect.stringContaining("rejected"),
          expect.stringContaining("object"),
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
    name: "S15 accepts every legal ToolResult shape, keeps attachment references, and rejects other returns",
    requirements: ["3b0dd02b"],
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
    requirements: ["732b2d4b", "a403d2a5"],
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
    requirements: ["7aa29e92", "f6fb47da", "c5f07383", "13b3351a", "47ded442"],
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
    requirements: ["77195da7", "e70c9393", "60822bc8"],
    run: async (driver) => {
      const tools = {
        finish: defineTool({
          description: "Finish",
          args: z.object({ summary: z.string() }),
          execute: async (_state, { summary }) => ok(JSON.stringify({ summary, extra: 1 })),
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
            stopTool: { tool: "finish", callId: "c_finish", status: "success", value: "all done" },
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
        expect(outcome.stopTool?.value).toBe(JSON.stringify({ summary: "second", extra: 1 }))
      })
      expect(later.requests).toHaveLength(2)
    },
  },
  {
    name: "S19 counts maxSteps per side and per turn and exposes the counters to tools",
    requirements: ["c5ab8a06", "bc5ba253"],
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
    requirements: ["60822bc8", "47ded442", "bc5ba253"],
    run: async (driver) => {
      const tools = { finish: defineTool({ description: "Finish", execute: async () => ok("finished") }) }
      const side = { stopTool: "finish", maxSteps: 1 }
      const toolStop = new ScriptedProvider([{ text: "wrapping up", toolCalls: [{ name: "finish", arguments: {} }] }])
      await using(driver, { provider: toolStop, tools, side }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ reason: "stop_tool", steps: 1 })
      })
      const responseStop = new ScriptedProvider([{ text: "just text" }])
      await using(driver, { provider: responseStop, tools, side }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ reason: "stop_on_response", steps: 1 })
      })
      const limit = new ScriptedProvider([{ text: "", toolCalls: [] }])
      await using(driver, { provider: limit, tools, side }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ reason: "max_side_steps", steps: 1 })
      })
    },
  },
  {
    name: "S21 records empty and reasoning-only responses as completed steps without a response stop",
    requirements: ["7aa29e92", "c5ab8a06"],
    run: async (driver) => {
      const provider = new ScriptedProvider([
        { text: null },
        { text: "" },
        { text: "   " },
        { reasoning: "thinking only" },
        { text: "real" },
      ])
      await using(driver, { provider, side: { maxSteps: 5 } }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({
          status: "idle",
          reason: "stop_on_response",
          steps: 5,
        })
        expect(
          (await session.messages(thread))
            .filter((m) => m.role === "assistant")
            .map((m) => [m.content, m.reasoning_content, m.tool_calls]),
        ).toEqual([
          [null, null, null],
          ["", null, null],
          ["   ", null, null],
          [null, "thinking only", null],
          ["real", null, null],
        ])
      })
      expect(provider.requests).toHaveLength(5)
      const capped = new ScriptedProvider([{ text: null }, { text: null }, { text: null }])
      await using(driver, { provider: capped, side: { maxSteps: 2 } }, async (session, thread) => {
        expect(await send(session, thread, "go")).toMatchObject({ reason: "max_side_steps", steps: 2 })
      })
    },
  },
  {
    name: "S22 retries retryable provider errors within the budget and settles failed on the others",
    requirements: ["e50614cd"],
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
          expect(outcome.modelCalls[0]?.error).toEqual({ message: "the upstream refused", code })
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
      const cut = new ScriptedProvider([{ chunks: partial }])
      await using(driver, { provider: cut }, async (session, thread) => {
        const outcome = await send(session, thread, "go", { retries: 0 })
        expect(outcome).toMatchObject({ status: "failed", reason: "step_error" })
        expect(outcome.error?.message).toContain("finish")
      })
    },
  },
  {
    name: "S23 ignores tool annotations in the request, the validation, the execution, and the result",
    requirements: ["e2d0db94", "20a428b9", "cfce7619"],
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
    requirements: [],
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
    requirements: ["d263e879"],
    run: async (driver) => {
      const marker = "SECRET-MARKER-7f3a"
      const instance = { API_TOKEN: marker, LABEL: "shown" }
      const interpolating = (variables: PromptDefinition["variables"]) =>
        ({
          prompt: [
            { type: "text", content: "Token: " },
            { type: "env", property: "API_TOKEN" },
          ],
          ...(variables === undefined ? {} : { variables }),
        }) as Partial<PromptDefinition>
      for (const variables of [
        [{ name: "API_TOKEN", type: "secret" as const, required: true, description: "Token" }],
        undefined,
      ]) {
        const provider = new ScriptedProvider([{ text: "never" }])
        await using(
          driver,
          { provider, prompt: interpolating(variables) },
          async (session, thread) => {
            const outcome = await send(session, thread, "go")
            expect(outcome).toMatchObject({ status: "failed", reason: "fatal_error" })
            expect(outcome.error?.message).toContain("API_TOKEN")
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
          } as Partial<PromptDefinition>,
        },
        async (session, thread) => {
          await send(session, thread, "go")
          const stored = await session.messages(thread)
          expect(stored.filter((m) => m.role === "tool").map((m) => [m.tool_status, m.content])).toEqual([
            ["success", "authorized"],
            ["error", expect.stringContaining("MISSING_TOKEN")],
          ])
          expect(JSON.stringify(stored)).not.toContain(marker)
        },
        instance,
      )
      expect(provider.requests[0]?.messages[0]).toEqual({ role: "system", content: "Label: shown" })
      expect(JSON.stringify(provider.requests)).not.toContain(marker)
    },
  },
  {
    name: "S27 treats provider-executed tools and generated images as parts of one response and runs nothing locally",
    requirements: ["f6fb47da", "c5f07383"],
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
    requirements: [],
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
              createdAt: typeof state.createdAt,
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
            seen.push({ shared: state.context.shared, flowId: state.execution?.flowId })
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
      ])
      await using(driver, { provider, tools }, async (session, thread) => {
        await send(session, thread, "go")
        expect(seen[0]).toEqual({
          threadId: thread,
          agentId: "assistant",
          userId: null,
          createdAt: "number",
          terminated: null,
          arguments: {},
          execution: "string",
        })
        expect(seen[1]?.shared).toBe("from first")
        expect(seen[2]?.shared).toBe("from first")
        expect(seen[1]?.flowId).toBe(seen[2]?.flowId)
        await send(session, thread, "again")
      })
    },
  },
  {
    name: "S29 loads definitions and lists their names through ThreadState",
    requirements: ["c4b75828", "e3afb48b", "4d4c50a2", "cf66e53e", "be6b8ba1", "75fba4a7"],
    run: async (driver) => {
      let report: Record<string, unknown> = {}
      const tools = {
        survey: defineTool({
          description: "Survey",
          execute: async (state: ThreadState) => {
            const model = await state.loadModel<{ model: string }>("scripted")
            const prompt = await state.loadPrompt<{ name: string }>("assistant")
            const agent = await state.loadAgent<{ name: string }>("assistant")
            report = {
              model: model.model,
              prompt: prompt.name,
              agent: agent.name,
              prompts: state.getPromptNames(),
              agents: state.getAgentNames(),
              models: state.getModelNames(),
              missing: await state.loadModel("absent").then(
                () => "resolved",
                (error: Error) => error.message,
              ),
            }
            return ok("surveyed")
          },
        }),
      }
      const provider = new ScriptedProvider([{ toolCalls: [{ name: "survey", arguments: {} }] }, { text: "done" }])
      await using(driver, { provider, tools }, async (session, thread) => {
        await send(session, thread, "go")
      })
      expect(report).toEqual({
        model: "scripted-model-v1",
        prompt: "assistant",
        agent: "assistant",
        prompts: ["assistant"],
        agents: ["assistant"],
        models: ["scripted"],
        missing: "No model named absent is defined",
      })
    },
  },
  {
    name: "S30 makes an injected message durable at once, visible to the next tool, and eligible from the next assembly",
    requirements: ["8cefb16e", "b74ef581", "73bce32e", "6d37745b", "16606350", "8233eb0b", "41fe7364", "c4905fe6"],
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
      })
      expect(seen).toEqual([
        [true, "note from a tool", { source: "tool" }, true],
        ["go", null, "note from a tool", "injected"],
        5,
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
    },
  },
  {
    name: "S31 gives tools execution state with a flow id per execution, the root prompt path, and an abort signal",
    requirements: ["04d1538b", "c544edac", "6ad6d3c1", "8a66bc04", "6f984718", "18655cf1"],
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
              Array.isArray(execution?.messageHistory),
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
        await send(session, thread, "first")
        await send(session, thread, "second")
      })
      const flows = seen.map((entry) => (entry as Array<unknown>)[0])
      expect(typeof flows[0]).toBe("string")
      expect(flows[0]).toBe(flows[1])
      expect(flows[2]).not.toBe(flows[0])
      expect(seen.map((entry) => (entry as Array<unknown>).slice(1))).toEqual([
        [["assistant"], true, false, true],
        [["assistant"], true, false, true],
        [["assistant"], true, false, true],
      ])
    },
  },
  {
    name: "S32 resolves env by agent, tool entry, prompt, then instance, classifies it secret, and invokes a listed tool",
    requirements: ["341727f4", "a01f5667", "39260b1a", "d6567ce8", "7553bb50", "5522b650"],
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
          execute: async (state: ThreadState) => ok(await state.env("LEVEL")),
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
      expect(otherLevel).toBe("prompt-level")
    },
  },
  {
    name: "S33 passes ThreadState message reads, updates, and deletes through to thread storage",
    requirements: ["37e69561", "3489685d", "f67424cd", "bd122f30", "7f464a24", "1edbcdb1", "96307380", "79171656"],
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
    name: "S34 keeps a tool's key-value writes for later executions of the same thread and only that thread",
    requirements: ["d0bf2dee", "70e01371", "b680018e", "1c6df0f5", "5e2f73a8"],
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
]
