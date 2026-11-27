import {
  defineAgent,
  defineModel,
  definePrompt,
  defineTool,
  type Message,
  type PromptDefinition,
  type ThreadState,
} from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { callsOf, history, ok, runTurn, type Scenario, sideOf, stubTool, using } from "../harness.ts"

export const S28: Scenario = {
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
      await session.send(thread, "go")
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
      expect(await session.send(thread, "again")).toMatchObject({ status: "idle", reason: "stop_on_response" })
      expect(seen[3]?.shared).toBeUndefined()
      expect(seen[3]?.flowId).not.toBe(seen[2]?.flowId)
      expect(seen[3]?.created).toBe(createdAt)
    })
  },
}

export const S29: Scenario = {
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
      prompts: [definePrompt({ name: "second", toolDescription: "Second", model: "second_model", prompt: "Second." })],
      models: [defineModel({ name: "second_model", provider: other.factory, model: "second-model-v1" })],
      agents: [defineAgent({ name: "second_agent", sideA: { prompt: "second" }, sideB: { human: true } })],
    }
    await runTurn(driver, { provider, tools, ...extra }, "go")
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
}

export const S30: Scenario = {
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
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
      ["tool", "c_inject"],
      ["tool", "c_observe"],
      ["tool", "c_check"],
      ["user", "note from a tool"],
    ])
    expect(provider.requests[1]?.messages.filter((m) => m.role === "system").map((m) => m.content)).toEqual([
      "You are a test assistant.",
      "system note",
    ])
  },
}

export const S31: Scenario = {
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
      await session.send(thread, "first")
      await session.send(thread, "second")
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
}

export const S32: Scenario = {
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
        await session.send(thread, "go")
        otherLevel = (await session.messages(thread)).find((m) => m.tool_call_id === "c_other")?.content
      },
      { instanceEnv: { REGION: "instance-region", SOURCE: "instance" } },
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
}

export const S32b: Scenario = {
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
        await session.send(thread, "go")
      },
      {
        instanceEnv: {
          ALL_THREE: "from instance",
          PROMPT_AND_INSTANCE: "from instance",
          ONLY_INSTANCE: "from instance",
        },
      },
    )
    expect(resolved).toEqual(["from agent", "from prompt", "from instance"])
  },
}

export const S33: Scenario = {
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
          tool_calls: JSON.stringify([{ id: "old", type: "function", function: { name: "reader", arguments: "{}" } }]),
        },
        { role: "tool", content: "old result", name: "reader", tool_call_id: "old", tool_status: "success" },
        { role: "user", content: "quiet", silent: true },
        { role: "assistant", content: "nested", depth: 1 },
      ])
      await session.send(thread, "go")
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
}

export const S33b: Scenario = {
  name: "S33b deletes a side B model turn together with the tool results of its calls",
  requirements: ["96307380"],
  run: async (driver) => {
    const tools = {
      note: stubTool("Returns a note", "noted"),
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
      await session.send(thread, "go")
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
}

export const S34: Scenario = {
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

    await using(driver, { provider, tools }, async (session, thread) => {
      await session.send(thread, "remember teal")
      await session.send(thread, "what color?")
      const other = await session.createThread("assistant")
      await session.send(other, "what color?")
      const result = async (id: string, threadId: string) =>
        (await session.messages(threadId)).find((m) => m.tool_call_id === id)?.content
      expect(await result("c_later", thread)).toBe(JSON.stringify({ color: "teal" }))
      expect(await result("c_elsewhere", other)).toBe("null")
    })
  },
}
