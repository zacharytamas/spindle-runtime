import {
  defineHook,
  definePrompt,
  defineProvider,
  defineTool,
  type Message,
  type PromptDefinition,
  ProviderError,
  providerEnv,
  type ThreadState,
} from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import {
  callsOf,
  firstToolResult,
  history,
  holding,
  ok,
  type Scenario,
  type Setup,
  toolResults,
  using,
} from "../harness.ts"

export const S26: Scenario = {
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
    const cases: Array<[PromptDefinition["variables"], NonNullable<Setup["tools"]>]> = [
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
          const outcome = await session.send(thread, "go")
          expect(outcome).toMatchObject({ status: "failed", reason: "fatal_error" })
          expect(outcome.error?.message).toContain("API_TOKEN")
          expect(outcome.error?.message).toContain("Prompt assistant ")
          expect(outcome.error?.message).not.toContain(marker)
        },
        { instanceEnv: instance },
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
        await session.send(thread, "go")
        const stored = await session.messages(thread)
        expect(toolResults(stored).map((m) => [m.tool_status, m.content])).toEqual([
          ["success", "authorized"],
          ["error", expect.stringContaining("MISSING_TOKEN")],
        ])
        expect(holding(stored, marker)).toEqual([])
      },
      { instanceEnv: instance },
    )
    expect(provider.requests[0]?.messages[0]).toEqual({ role: "system", content: "Label: shown" })
    expect(holding(provider.requests, marker)).toEqual([])
  },
}

export const S26d: Scenario = {
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
          const outcome = await session.send(thread, "go")
          expect([label, outcome.status, outcome.reason, outcome.error?.message]).toEqual([
            label,
            "failed",
            "fatal_error",
            expect.stringMatching(message),
          ])
          expect(outcome.error?.message).not.toContain(marker)
        },
        { instanceEnv: { API_TOKEN: marker, SERVICE_KEY: marker } },
      )
      expect([label, setup.provider.requests.length]).toEqual([label, 0])
    }
  },
}

export const S26e: Scenario = {
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
        const outcome = await session.send(thread, "go")
        expect([outcome.status, outcome.reason]).toEqual(["failed", "fatal_error"])
        expect(outcome.error?.message).toMatch(
          /^Prompt assistant interpolates variable DISPLAY, whose value comes from/,
        )
        expect(holding(outcome, instance.DISPLAY)).toEqual([])
      },
      { instanceEnv: instance },
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
        const outcome = await session.send(thread, "go")
        expect(outcome.error?.message).toMatch(/^The system prompt that prompt assistant renders holds a secret value/)
      },
      { instanceEnv: instance },
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
        const outcome = await session.send(thread, "go")
        expect([outcome.reason, outcome.steps]).toEqual(["fatal_error", 1])
        expect(outcome.error?.message).toMatch(/^The system prompt that prompt assistant renders holds a secret value/)
      },
      { instanceEnv: instance },
    )
    expect(zone.requests).toHaveLength(1)
  },
}

export const S26f: Scenario = {
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
        await session.send(thread, `hello ${marker}`)
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
      { instanceEnv: { MARK: marker } },
    )
    expect(written.map((m) => m.content)).toEqual(["injected [redacted]", "edited [redacted]"])
    expect(history(provider.requests[1]).map((m) => m.content)).toEqual([
      `hello ${marker}`,
      `calling ${marker}`,
      "written",
      "injected [redacted]",
      "edited [redacted]",
    ])
  },
}

export const S26g: Scenario = {
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
        await session.send(thread, "go")
        const result = firstToolResult(await session.messages(thread))
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
      { instanceEnv: { MARK: marker } },
    )
    expect(holding(provider.requests, marker)).toEqual([])
  },
}

export const S26h: Scenario = {
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
        await session.send(thread, "go")
        const result = firstToolResult(await session.messages(thread))
        expect([result?.tool_status, result?.content]).toEqual([
          "error",
          "ok\n\n[redacted] dropped the new file a.txt, because this version cannot store a new file. The thread file system arrives in M3.",
        ])
      },
      { instanceEnv: { MARK: "Spindle" } },
    )
    expect(holding(provider.requests, "Spindle")).toEqual([])
  },
}

export const S26i: Scenario = {
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
        await session.send(thread, "go")
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
      { instanceEnv: { MARK: mark } },
    )
    expect(holding(provider.requests, mark)).toEqual([])
  },
}

export const S26b: Scenario = {
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
          attachments: [{ name: `report ${await state.env("SHORT_TOKEN")}.txt`, mimeType: "text/plain", data: "YQ==" }],
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
        const outcome = await session.send(thread, "go")
        expect(outcome.error?.message).toBe("upstream echoed [redacted] and [redacted]")
        const stored = await session.messages(thread)
        const result = firstToolResult(stored)
        expect([result?.content, result?.metadata]).toEqual([
          "short [redacted]",
          { error_code: "denied", error_data: { quoted: "[redacted]", nested: ["[redacted]"], count: 7 } },
        ])
        for (const secret of Object.values(instance))
          expect(holding([stored, provider.requests, outcome], secret)).toEqual([])
      },
      { instanceEnv: instance },
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
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        const result = firstToolResult(await session.messages(thread))
        expect([result?.tool_status, result?.content, result?.metadata]).toEqual([
          "error",
          "r[redacted]j[redacted]ct[redacted]d",
          { error_data: { "k[redacted]y [redacted]": "k[redacted]pt" } },
        ])
      },
      { instanceEnv: { ONE_CHAR: "e" } },
    )
  },
}

export const S26c: Scenario = {
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
        await session.send(thread, "go")
        const model = (await session.messages(thread)).find((m) => m.role === "assistant")
        expect([model?.content, model?.reasoning_content, callsOf(model)]).toEqual([
          "the sum is 4",
          "it said sum",
          [{ id: "e1", type: "function", function: { name: "check", arguments: '{"label":"sum of parts"}' } }],
        ])
      },
      { instanceEnv: { SHORT_TOKEN: "sum" } },
    )
    expect(received).toEqual({ label: "sum of parts" })
    expect(history(echoing.requests[1]).find((m) => m.role === "assistant")).toEqual({
      role: "assistant",
      content: "the sum is 4",
      reasoning: "it said sum",
      toolCalls: [{ id: "e1", name: "check", arguments: { label: "sum of parts" } }],
    })
  },
}
