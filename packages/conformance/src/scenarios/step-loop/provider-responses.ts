import {
  defineModel,
  definePrompt,
  defineProvider,
  defineTool,
  type Message,
  type PromptDefinition,
  ProviderError,
  type ProviderFactoryWithOptions,
  type ProviderStreamChunk,
  type ResponseSummary,
} from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider, type ScriptStep } from "../../ScriptedProvider.ts"
import {
  callsOf,
  counter,
  gate,
  history,
  holding,
  ok,
  runTurn,
  type Scenario,
  shape,
  sideOf,
  stubTool,
  using,
} from "../harness.ts"

export const S07: Scenario = {
  name: "S07 passes toolChoice through, sends none with the definitions, and never runs a call the prompt forbids",
  requirements: ["539cf227", "d0ac352d", "20479ea7", "975e02f5", "ea4bf54e", "2f53909a"],
  run: async (driver) => {
    const runs = counter()
    const tools = { act: defineTool({ description: "Act", execute: async () => runs.tick(ok("acted")) }) }
    const call = { toolCalls: [{ name: "act", arguments: {} }] }
    const auto = new ScriptedProvider([call, { text: "done" }])
    expect(await runTurn(driver, { provider: auto, tools, prompt: { toolChoice: "auto" } }, "go")).toMatchObject({
      status: "idle",
      steps: 2,
    })
    expect(auto.requests[0]?.toolChoice).toBe("auto")
    expect(runs.count).toBe(1)
    const unset = new ScriptedProvider([{ text: "done" }])
    expect(await runTurn(driver, { provider: unset, tools }, "go")).toMatchObject({ status: "idle", steps: 1 })
    expect(unset.requests[0]).not.toHaveProperty("toolChoice")
    const required = new ScriptedProvider([call])
    expect(
      await runTurn(
        driver,
        { provider: required, tools, prompt: { toolChoice: "required" }, side: { maxSteps: 1 } },
        "go",
      ),
    ).toMatchObject({ status: "idle", reason: "max_side_steps" })
    expect(required.requests[0]?.toolChoice).toBe("required")
    expect(runs.count).toBe(2)
    const none = new ScriptedProvider([call, { text: "no tools used" }])
    await using(driver, { provider: none, tools, prompt: { toolChoice: "none" } }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({
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
      const outcome = await session.send(thread, "go", { retries: 1 })
      expect(outcome).toMatchObject({ status: "failed", reason: "step_error" })
      expect(outcome.error?.message).toContain("none")
      expect(shape(await session.messages(thread))).toEqual([["user", "go"]])
    })
    expect(runs.count).toBe(2)
  },
}

export const S08: Scenario = {
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
        const outcome = await session.send(thread, "go")
        expect(outcome).toMatchObject({ status: "idle", reason: "max_side_steps", steps: 1 })
        expect(outcome.modelCalls.map((call) => call.rejected === undefined)).toEqual([false, true])
        expect((await session.messages(thread)).map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      },
    )
    expect(provider.requests).toHaveLength(2)
    expect(runs.count).toBe(1)
    const stubborn = new ScriptedProvider([{ text: "no" }, { text: "still no" }])
    await using(driver, { provider: stubborn, tools, prompt: { toolChoice: "required" } }, async (session, thread) => {
      const outcome = await session.send(thread, "go", { retries: 1 })
      expect(outcome).toMatchObject({ status: "failed", reason: "step_error", steps: 0 })
      expect(shape(await session.messages(thread))).toEqual([["user", "go"]])
    })
    expect(stubborn.requests).toHaveLength(2)
  },
}

export const S09: Scenario = {
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
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
}

export const S10: Scenario = {
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
          prompts: [definePrompt({ name: "other", toolDescription: "Other", model: "other_model", prompt: "Other." })],
          models: [defineModel({ name: "other_model", provider: other.factory, model: "other-model-v1" })],
        },
        async (session, thread) => {
          for (const text of ["q1", "q2", "q3", "q4"]) await session.send(thread, text)
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
          await session.send(thread, "q5")
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
}

export const S11: Scenario = {
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
    const tools = { note: stubTool("Note", "noted") }
    await using(driver, { provider, tools }, async (session, thread) => {
      const running = session.send(thread, "go")
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
}

export const S11b: Scenario = {
  name: "S11b drops circular provider metadata from the model call log",
  requirements: [],
  run: async (driver) => {
    const secret = "metadata-secret-41"
    const metadata: Record<string, unknown> = { token: secret }
    metadata.self = metadata
    const provider = new ScriptedProvider([{ text: "done" }], { getResponseMetadata: async () => metadata })
    const prompt = { variables: [{ name: "TOKEN", type: "secret" as const, description: "Token", required: true }] }
    await using(
      driver,
      { provider, prompt },
      async (session, thread) => {
        const outcome = await session.send(thread, "go")
        expect(outcome.modelCalls.map((call) => call.metadata)).toEqual([null])
        expect(holding(outcome, secret)).toEqual([])
      },
      { instanceEnv: { TOKEN: secret } },
    )
  },
}

export const S21: Scenario = {
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
      const outcome = await session.send(thread, "go", { retries: 4 })
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
      const outcome = await session.send(thread, "go", { retries: 2 })
      expect(outcome).toMatchObject({ status: "failed", reason: "step_error", steps: 0 })
      expect(outcome.error?.message).toBe("The model returned nothing, with no text and no tool call, after 3 requests")
      expect(shape(await session.messages(thread))).toEqual([["user", "go"]])
    })
  },
}

export const S22: Scenario = {
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
        const outcome = await session.send(thread, "go", { retries: 1 })
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
      const outcome = await session.send(thread, "go", { retries: 2 })
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
      const outcome = await session.send(thread, "go", { retries: 2 })
      expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      expect(outcome.modelCalls.map((call) => call.error?.code)).toEqual(["server_error", "server_error", undefined])
      expect(shape(await session.messages(thread))).toEqual([
        ["user", "go"],
        ["assistant", "after the cut"],
      ])
    })
    expect(ran.count).toBe(0)
    const cutOff = new ScriptedProvider([{ chunks: partial }])
    const cutOffOutcome = await runTurn(driver, { provider: cutOff }, "go", { retries: 0 })
    expect(cutOffOutcome).toMatchObject({ status: "failed", reason: "step_error" })
    expect(cutOffOutcome.error).toMatchObject({ code: "server_error", message: expect.stringContaining("finish") })
    const native = new ScriptedProvider([
      { reject: new DOMException("The operation timed out.", "TimeoutError") },
      { text: "recovered" },
    ])
    const nativeOutcome = await runTurn(driver, { provider: native }, "go", { retries: 1 })
    expect(nativeOutcome).toMatchObject({ status: "idle", steps: 1 })
    expect(nativeOutcome.modelCalls[0]?.error?.code).toBe("timeout")
  },
}

export const S36: Scenario = {
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
    const outcome = await runTurn(driver, { provider, model: { provider: extension } }, "go")
    expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
    expect(log).toEqual(["build 1", "send 1", "build 2", "send 2"])
  },
}

export const S27: Scenario = {
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
      const outcome = await session.send(thread, "search")
      expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      expect(outcome.modelCalls[0]).toMatchObject({ images: 2, providerTools: 2 })
      expect(shape(await session.messages(thread))).toEqual([
        ["user", "search"],
        ["assistant", "Here is what I found"],
      ])
    })
    expect(local.count).toBe(0)
  },
}
