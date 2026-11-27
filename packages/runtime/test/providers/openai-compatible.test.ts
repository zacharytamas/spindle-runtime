import { assert, describe, expect, it } from "@effect/vitest"
import {
  defineModel,
  defineProvider,
  defineTool,
  type ProviderError,
  type ProviderFactoryWithOptions,
  type ProviderReasoningDetail,
  type ProviderRequest,
  type ProviderStreamChunk,
  providerConst,
  providerEnv,
} from "@standardagents/spec"
import { ConfigProvider, Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/http"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { ok, using } from "../../../conformance/src/scenarios/harness.ts"
import { newSecrets } from "../../src/execution/env.ts"
import { SetupError } from "../../src/execution/turn.ts"
import { providerFor } from "../../src/providers/config.ts"
import { openaiCompatible, requestBody } from "../../src/providers/openai-compatible.ts"
import { spindleDriver } from "../spindle-driver.ts"

interface Sent {
  readonly url: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

const sse = (events: ReadonlyArray<unknown>) =>
  new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })

const transport = (answer: (sent: Sent) => Response) => {
  const sent: Array<Sent> = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const entry = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
    sent.push(entry)
    return answer(entry)
  }
  return { sent, fetch }
}

const streamed = [
  { id: "gen-1", choices: [{ delta: { reasoning_content: "Thinking. " } }] },
  { choices: [{ delta: { content: "It is " } }] },
  {
    choices: [
      { delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "lookup", arguments: '{"q":' } }] } },
    ],
  },
  {
    choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "lookup", arguments: "{bad" } }] } }],
  },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"rain"}' } }] } }] },
  { choices: [{ delta: { content: "raining." }, finish_reason: "tool_calls" }] },
  {
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 0,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  },
]

const generated = {
  id: "gen-2",
  choices: [
    {
      message: {
        content: "It is raining.",
        reasoning_content: "Thinking. ",
        tool_calls: [{ id: "call_a", type: "function", function: { name: "lookup", arguments: '{"q":"rain"}' } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
}

const request: ProviderRequest = {
  model: "native-model",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Weather?" },
    {
      role: "assistant",
      content: null,
      reasoning: "earlier thought",
      toolCalls: [{ id: "call_0", name: "lookup", arguments: { q: "sun" } }],
    },
    { role: "tool", toolCallId: "call_0", toolName: "lookup", content: { type: "error", error: "no data" } },
  ],
  tools: [{ type: "function", function: { name: "lookup", description: "Look up", parameters: { type: "object" } } }],
  toolChoice: "required",
  parallelToolCalls: false,
  reasoning: { level: 57, levels: { 0: "none", 33: "low", 66: "medium", 100: "high" }, maxTokens: 64 },
  providerOptions: { reasoning_effort: "low", seed: 7 },
}

const collect = async (chunks: AsyncIterable<ProviderStreamChunk>) => {
  const all: Array<ProviderStreamChunk> = []
  for await (const chunk of chunks) all.push(chunk)
  return all
}

describe("openaiCompatible", () => {
  it("routes generate and stream through the injected fetch with the base URL and default headers", async () => {
    const { sent, fetch } = transport((entry) =>
      entry.body.stream === true ? sse(streamed) : Response.json(generated),
    )
    const provider = openaiCompatible({
      apiKey: "key-1",
      baseUrl: "http://backend.test/v1/",
      defaultHeaders: { "x-account": "acct-7" },
      fetch,
    })
    await provider.generate(request)
    await collect(await provider.stream(request))
    expect(sent.map((entry) => entry.url)).toEqual([
      "http://backend.test/v1/chat/completions",
      "http://backend.test/v1/chat/completions",
    ])
    for (const entry of sent) {
      expect(entry.headers.get("authorization")).toBe("Bearer key-1")
      expect(entry.headers.get("x-account")).toBe("acct-7")
    }
    expect([sent[0]?.body.stream, sent[1]?.body.stream]).toEqual([undefined, true])
  })

  it("sends no Authorization header when the key is empty", async () => {
    const { sent, fetch } = transport(() => Response.json(generated))
    await openaiCompatible({ apiKey: "", baseUrl: "http://local.test/v1", fetch }).generate(request)
    expect(sent[0]?.headers.has("authorization")).toBe(false)
  })

  it("fails a request that outlives the timeout slot with a timeout ProviderError", async () => {
    const fetch = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })
    const error = await openaiCompatible({ apiKey: "", timeout: 20, fetch })
      .generate(request)
      .catch((cause) => cause)
    expect([error.code, error.isRetryable, error.origin]).toEqual(["timeout", true, "provider:openai_compatible"])
  })

  it("fails a body that outlives the timeout slot after the headers arrived with a timeout ProviderError", async () => {
    const fetch = async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start: (controller) => init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason)),
        }),
      )
    const provider = openaiCompatible({ apiKey: "", timeout: 20, fetch })
    const failures = [
      await provider.generate(request).catch((cause) => cause),
      await collect(await provider.stream(request)).catch((cause) => cause),
    ]
    for (const error of failures)
      expect([error.code, error.isRetryable, error.origin]).toEqual(["timeout", true, "provider:openai_compatible"])
    const malformed = await openaiCompatible({ apiKey: "", fetch: async () => new Response("not json") })
      .generate(request)
      .catch((cause) => cause)
    expect([malformed.constructor.name, malformed.code, malformed.origin]).toEqual([
      "ProviderError",
      "unknown",
      "provider:openai_compatible",
    ])
  })

  it("classifies a 401 by its status only after the error body completes", async () => {
    const caller = new AbortController()
    let cancelDuringRead = false
    const provider = openaiCompatible({
      apiKey: "",
      timeout: 20,
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            pull(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true })
              if (init?.signal && cancelDuringRead) caller.abort(new DOMException("cancelled", "AbortError"))
            },
          }),
          { status: 401 },
        ),
    })
    await expect(provider.generate(request)).rejects.toMatchObject({ code: "timeout", isRetryable: true })
    cancelDuringRead = true
    await expect(provider.stream({ ...request, signal: caller.signal })).rejects.toMatchObject({
      code: "unknown",
      isRetryable: false,
    })
    const complete = openaiCompatible({ apiKey: "", fetch: async () => new Response("denied", { status: 401 }) })
    await expect(complete.generate(request)).rejects.toMatchObject({ code: "auth_error", statusCode: 401 })
  })

  it("fails with a retryable timeout when the transport times out, and never for a request the caller cancelled", async () => {
    const deadline = () => new DOMException("transport deadline", "TimeoutError")
    const erroring = (error: unknown) => async () =>
      new Response(new ReadableStream({ start: (controller) => controller.error(error) }))
    const wrapped = Object.assign(new Error("Headers Timeout Error"), {
      name: "HeadersTimeoutError",
      code: "UND_ERR_HEADERS_TIMEOUT",
    })
    const transports = [
      erroring(deadline()),
      erroring(new TypeError("terminated", { cause: { code: "UND_ERR_BODY_TIMEOUT" } })),
      async () => Promise.reject(new TypeError("fetch failed", { cause: wrapped })),
    ]
    for (const fetch of transports) {
      const provider = openaiCompatible({ apiKey: "", fetch })
      const failures = [
        await provider.generate(request).catch((cause) => cause),
        await provider
          .stream(request)
          .then(collect)
          .catch((cause) => cause),
      ]
      for (const error of failures)
        expect([error.code, error.isRetryable, error.origin]).toEqual(["timeout", true, "provider:openai_compatible"])
    }
    const cancel = new AbortController()
    cancel.abort(deadline())
    const cancelled = await openaiCompatible({
      apiKey: "",
      fetch: async (_input, init) => Promise.reject(init?.signal?.reason),
    })
      .generate({ ...request, signal: cancel.signal })
      .catch((cause) => cause)
    expect([cancelled.code, cancelled.isRetryable]).toEqual(["unknown", false])
  })

  it("maps the standard request to chat completions, and a reasoning level replaces only the native effort", () => {
    const body = requestBody(request, true)
    expect(body).toMatchObject({
      model: "native-model",
      seed: 7,
      reasoning_effort: "medium",
      tool_choice: "required",
      parallel_tool_calls: false,
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        { type: "function", function: { name: "lookup", description: "Look up", parameters: { type: "object" } } },
      ],
    })
    expect(body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "earlier thought",
        tool_calls: [{ id: "call_0", type: "function", function: { name: "lookup", arguments: '{"q":"sun"}' } }],
      },
      { role: "tool", tool_call_id: "call_0", content: "no data" },
    ])
    expect(
      requestBody({ ...request, reasoning: { level: 0, levels: { 0: "none", 100: "high" } } }, false),
    ).toMatchObject({
      reasoning_effort: "none",
    })
    expect(
      requestBody({ ...request, reasoning: { level: 0, levels: { 0: null, 100: "high" } } }, false),
    ).not.toHaveProperty("reasoning_effort")
    expect(
      requestBody({ ...request, reasoning: { level: 0, levels: { 33: "low", 100: "high" } } }, false),
    ).toMatchObject({ reasoning_effort: "low" })
    expect(requestBody({ ...request, reasoning: { level: 0, levels: { 0: null } } }, false)).not.toHaveProperty(
      "reasoning_effort",
    )
    expect(requestBody({ ...request, reasoning: { maxTokens: 64 } }, false)).toMatchObject({ reasoning_effort: "low" })
    expect(requestBody({ ...request, reasoning: { level: 57 } }, false)).toMatchObject({ reasoning_effort: "low" })
    const bare = requestBody({ model: "m", messages: [], toolChoice: "none", parallelToolCalls: true }, false)
    expect(bare).not.toHaveProperty("tool_choice")
    expect(bare).not.toHaveProperty("parallel_tool_calls")
  })

  it("streams chunk by chunk and gives no tool-call-done to a call whose arguments are not a JSON object", async () => {
    const { fetch } = transport(() => sse(streamed))
    const chunks = await collect(await openaiCompatible({ apiKey: "", fetch }).stream(request))
    expect(chunks).toEqual([
      { type: "reasoning-delta", delta: "Thinking. " },
      { type: "content-delta", delta: "It is " },
      { type: "tool-call-start", id: "call_a", name: "lookup" },
      { type: "tool-call-delta", id: "call_a", argumentsDelta: '{"q":' },
      { type: "tool-call-start", id: "call_b", name: "lookup" },
      { type: "tool-call-delta", id: "call_b", argumentsDelta: "{bad" },
      { type: "tool-call-delta", id: "call_a", argumentsDelta: '"rain"}' },
      { type: "content-delta", delta: "raining." },
      { type: "reasoning-done" },
      { type: "content-done" },
      { type: "tool-call-done", id: "call_a", arguments: { q: "rain" } },
      {
        type: "finish",
        finishReason: "tool_calls",
        usage: { promptTokens: 12, completionTokens: 0, totalTokens: 12, cachedTokens: 0, reasoningTokens: 3 },
      },
    ])
  })

  it("delivers a final event that the endpoint did not end with a blank line", async () => {
    const whole = await collect(
      await openaiCompatible({ apiKey: "", fetch: transport(() => sse(streamed)).fetch }).stream(request),
    )
    for (const ending of ["", "\n", "\r\n", "\r"]) {
      const body = streamed.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + ending
      const { fetch } = transport(() => new Response(body))
      expect(await collect(await openaiCompatible({ apiKey: "", fetch }).stream(request))).toEqual(whole)
    }
  })

  it("reads each data line as one event, with or without a blank line after it", async () => {
    const whole = await collect(
      await openaiCompatible({ apiKey: "", fetch: transport(() => sse(streamed)).fetch }).stream(request),
    )
    const body = `${streamed.map((event) => `data: ${JSON.stringify(event)}\n`).join("")}data: [DONE]\n`
    const { fetch } = transport(() => new Response(body))
    expect(await collect(await openaiCompatible({ apiKey: "", fetch }).stream(request))).toEqual(whole)
    // The endpoint keeps the connection open after the sentinel. The response is over all the same.
    const open = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode(body)),
    })
    const held = transport(() => new Response(open))
    expect(await collect(await openaiCompatible({ apiKey: "", fetch: held.fetch }).stream(request))).toEqual(whole)
  })

  it("ends a stream cut off before a finish reason with a retryable error and no tool-call-done", async () => {
    const cut = streamed.slice(0, 5).map((event) => `data: ${JSON.stringify(event)}\n\n`)
    for (const ending of ["data: [DONE]\n\n", ""]) {
      const { fetch } = transport(() => new Response(`${cut.join("")}${ending}`))
      const seen: Array<string> = []
      const error = await (async () => {
        for await (const chunk of await openaiCompatible({ apiKey: "", fetch }).stream(request)) seen.push(chunk.type)
      })().catch((cause) => cause)
      expect([error.code, error.isRetryable, error.origin]).toEqual([
        "server_error",
        true,
        "provider:openai_compatible",
      ])
      expect(seen).toContain("tool-call-delta")
      expect(seen).not.toContain("tool-call-done")
      expect(seen).not.toContain("finish")
    }
  })

  it("keeps the structured reasoning of a response and sends it back in the fields it arrived in", async () => {
    const wire = [
      { type: "reasoning.text", text: "step one", signature: "sig-1", format: "anthropic-claude-v1" },
      { type: "reasoning.summary", id: "s1", summary: "short", signature: "sig-2" },
      { type: "reasoning.encrypted", data: "blob" },
    ]
    const fragments = [
      {
        choices: [
          {
            delta: {
              reasoning_content: "Think. ",
              reasoning_details: [{ ...wire[0], text: "step ", signature: undefined, index: 0 }],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { reasoning_details: [{ type: "reasoning.text", text: "one", signature: "sig-1", index: 0 }] } },
        ],
      },
      {
        choices: [
          {
            delta: {
              content: "Done.",
              reasoning_details: [
                { ...wire[1], index: 1 },
                { ...wire[2], index: 2 },
              ],
            },
            finish_reason: "stop",
          },
        ],
      },
    ]
    const message = { content: "Done.", reasoning_content: "Think. ", reasoning_details: wire }
    const { fetch } = transport((entry) =>
      entry.body.stream === true ? sse(fragments) : Response.json({ choices: [{ message, finish_reason: "stop" }] }),
    )
    const provider = openaiCompatible({ apiKey: "", fetch })
    const standard: Array<ProviderReasoningDetail> = [
      { type: "text", text: "step one", data: "sig-1", format: "anthropic-claude-v1" },
      { type: "summary", id: "s1", text: "short", data: "sig-2" },
      { type: "encrypted", data: "blob" },
    ]
    expect(await provider.generate(request)).toMatchObject({ reasoning: "Think. ", reasoningDetails: standard })
    const chunks = await collect(await provider.stream(request))
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reasoningDetails: standard })
    const replayed = requestBody(
      {
        model: "m",
        messages: [{ role: "assistant", content: "Done.", reasoning: "Think. ", reasoningDetails: standard }],
      },
      false,
    )
    expect(replayed.messages).toEqual([
      { role: "assistant", content: "Done.", reasoning_content: "Think. ", reasoning_details: wire },
    ])
  })

  it("returns no reasoning from generate or stream when the request excludes it", async () => {
    const message = {
      content: "Done.",
      reasoning_content: "hidden",
      reasoning_details: [{ type: "reasoning.text", text: "hidden" }],
    }
    const { fetch } = transport((entry) =>
      entry.body.stream === true
        ? sse([{ choices: [{ delta: message, finish_reason: "stop" }] }])
        : Response.json({ choices: [{ message, finish_reason: "stop" }] }),
    )
    const provider = openaiCompatible({ apiKey: "", fetch })
    const excluding = { ...request, reasoning: { exclude: true } }
    const generated = await provider.generate(excluding)
    expect([generated.content, generated.reasoning, generated.reasoningDetails]).toEqual([
      "Done.",
      undefined,
      undefined,
    ])
    const chunks = await collect(await provider.stream(excluding))
    expect(JSON.stringify(chunks)).not.toContain("hidden")
    expect(chunks.map((chunk) => chunk.type)).toEqual(["content-delta", "content-done", "finish"])
  })

  it("returns from generate the same text, reasoning, call, and finish that stream yields", async () => {
    const { fetch } = transport(() => Response.json(generated))
    expect(await openaiCompatible({ apiKey: "", fetch }).generate(request)).toEqual({
      content: "It is raining.",
      reasoning: "Thinking. ",
      toolCalls: [{ id: "call_a", name: "lookup", arguments: { q: "rain" } }],
      finishReason: "tool_calls",
      usage: { promptTokens: 12, completionTokens: 0, totalTokens: 12 },
      metadata: { requestId: "gen-2" },
    })
  })

  it("throws a typed ProviderError with the status, retry delay, and origin of an HTTP failure", async () => {
    const answers = [
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "retry-after": "3" },
      }),
      new Response("nope", { status: 401 }),
      new Response("forbidden", { status: 403 }),
      new Response("bad", { status: 400 }),
      new Response("down", { status: 503 }),
    ]
    const { fetch } = transport(() => answers.shift() ?? new Response("", { status: 500 }))
    const provider = openaiCompatible({ apiKey: "", fetch })
    const failures: Array<ProviderError> = []
    for (let index = 0; index < 5; index++) failures.push(await provider.generate(request).catch((error) => error))
    expect(failures.map((error) => [error.code, error.statusCode, error.retryAfter, error.origin])).toEqual([
      ["rate_limit", 429, 3, "provider:openai_compatible"],
      ["auth_error", 401, undefined, "provider:openai_compatible"],
      ["auth_error", 403, undefined, "provider:openai_compatible"],
      ["invalid_request", 400, undefined, "provider:openai_compatible"],
      ["server_error", 503, undefined, "provider:openai_compatible"],
    ])
    expect(failures[0]?.message).toContain("slow down")
    expect(failures.every((error) => error.isRetryable === ["rate_limit", "server_error"].includes(error.code))).toBe(
      true,
    )
  })
})

describe("provider config slots", () => {
  const extension = defineProvider({
    name: "lane_endpoint",
    baseProvider: openaiCompatible,
    config: {
      baseUrl: providerEnv("LANE_BASE_URL", { valueType: "url", required: true }),
      apiKey: providerEnv("LANE_API_KEY", { valueType: "secret" }),
      defaultHeaders: {
        "x-account": providerEnv("LANE_ACCOUNT"),
        "x-beta": "on",
        "x-unset": providerEnv("LANE_UNSET"),
      },
    },
  })
  const loaded = (provider: ProviderFactoryWithOptions) => ({
    kind: "model" as const,
    name: "lane",
    qualifiedName: "lane",
    package: undefined,
    file: "memory",
    path: "",
    value: defineModel({ name: "lane", provider, model: "native-model" }),
  })
  const build = (provider: ProviderFactoryWithOptions, env: Record<string, string>) => {
    const { sent, fetch } = transport(() => Response.json(generated))
    const secrets = newSecrets()
    return Effect.gen(function* () {
      const configured = yield* providerFor(loaded(provider), {} as never, secrets)
      assert(configured.lifetime === "shared")
      const instance = configured.provider
      yield* Effect.promise(() => instance.generate(request))
      return { sent, secrets }
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    )
  }

  it.effect("resolves an extension's sources, forwards its header map without unset leaves, and records secrets", () =>
    Effect.gen(function* () {
      const { sent, secrets } = yield* build(extension, {
        LANE_BASE_URL: "http://lane.test/v1",
        LANE_API_KEY: "lane-key",
        LANE_ACCOUNT: "acct-9",
      })
      expect(sent[0]?.url).toBe("http://lane.test/v1/chat/completions")
      expect(sent[0]?.headers.get("authorization")).toBe("Bearer lane-key")
      expect(sent[0]?.headers.get("x-account")).toBe("acct-9")
      expect(sent[0]?.headers.get("x-beta")).toBe("on")
      expect(sent[0]?.headers.has("x-unset")).toBe(false)
      expect([[...secrets.names], [...secrets.values]]).toEqual([["LANE_API_KEY"], ["lane-key"]])
    }),
  )

  it.effect("records a secret slot's value when an extension sets it as a constant or a literal", () =>
    Effect.gen(function* () {
      for (const [apiKey, value] of [
        [providerConst("const-key"), "const-key"],
        ["literal-key", "literal-key"],
      ] as const) {
        const fixed = defineProvider({ name: "fixed_key", baseProvider: openaiCompatible, config: { apiKey } })
        const { sent, secrets } = yield* build(fixed, {})
        expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${value}`)
        expect([[...secrets.names], [...secrets.values]]).toEqual([[], [value]])
      }
    }),
  )

  it.effect("uses the base slot's defaultEnv and then its default when no extension overrides the slot", () =>
    Effect.gen(function* () {
      const withEnv = yield* build(openaiCompatible, {
        OPENAI_BASE_URL: "http://env.test/v1",
        OPENAI_API_KEY: "env-key",
      })
      expect(withEnv.sent[0]?.url).toBe("http://env.test/v1/chat/completions")
      expect(withEnv.sent[0]?.headers.get("authorization")).toBe("Bearer env-key")
      const bare = yield* build(openaiCompatible, {})
      expect(bare.sent[0]?.url).toBe("https://api.openai.com/v1/chat/completions")
      expect(bare.sent[0]?.headers.has("authorization")).toBe(false)
      expect(openaiCompatible.configSlots?.apiKey).toMatchObject({ type: "secret", defaultEnv: "OPENAI_API_KEY" })
      expect([[...withEnv.secrets.names], [...withEnv.secrets.values]]).toEqual([["OPENAI_API_KEY"], ["env-key"]])
    }),
  )

  it.effect("reports a missing required variable before any request reaches the backend", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(build(extension, {}))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        expect(error?._tag === "Fail" ? error.error : undefined).toEqual(
          new SetupError({ message: "The provider of model lane needs LANE_BASE_URL, which has no value" }),
        )
      }
    }),
  )

  it.effect("builds an extension with createFetch again for each request, with the thread state", () =>
    Effect.gen(function* () {
      const states: Array<unknown> = []
      const { sent, fetch } = transport(() => Response.json(generated))
      const perRequest = defineProvider({
        name: "per_request",
        baseProvider: openaiCompatible,
        config: { baseUrl: "http://tunnel.test/v1" },
        createFetch: ({ state }) => {
          states.push(state)
          return fetch
        },
      })
      const state = { threadId: "thread-1" }
      const next = yield* providerFor(loaded(perRequest), state as never, newSecrets())
      assert(next.lifetime === "perRequest")
      for (const _ of [1, 2]) {
        const instance = yield* next.build
        yield* Effect.promise(() => instance.generate(request))
      }
      expect(states).toEqual([state, state])
      expect(sent.map((entry) => entry.url)).toEqual([
        "http://tunnel.test/v1/chat/completions",
        "http://tunnel.test/v1/chat/completions",
      ])
    }),
  )

  it.effect("hands the executing thread's state to a request-scoped override", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = []
      const overridden = defineProvider({
        name: "overridden",
        baseProvider: openaiCompatible,
        overrides: {
          generate: (context, next) => {
            seen.push(["generate", context.state])
            return next()
          },
          stream: (context, next) => {
            seen.push(["stream", context.state])
            return next()
          },
        },
      })
      const { fetch } = transport((entry) => (entry.body.stream === true ? sse(streamed) : Response.json(generated)))
      const state = { threadId: "thread-2" }
      const configured = yield* providerFor(loaded(overridden), state as never, newSecrets()).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
      )
      assert(configured.lifetime === "shared")
      const instance = configured.provider
      yield* Effect.promise(() => instance.generate(request))
      yield* Effect.promise(async () => collect(await instance.stream(request)))
      expect(seen).toEqual([
        ["generate", state],
        ["stream", state],
      ])
    }),
  )

  it.effect("fails setup when the model's provider factory throws or returns something that is not a provider", () =>
    Effect.gen(function* () {
      const failures: Array<string> = []
      for (const factory of [
        () => ({ name: "half" }),
        () => {
          throw new Error("no credentials")
        },
      ]) {
        const exit = yield* Effect.exit(providerFor(loaded(factory as never), {} as never, newSecrets()))
        const reason = Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail") : undefined
        failures.push(reason?._tag === "Fail" ? (reason.error as SetupError).message : "succeeded")
      }
      expect(failures).toEqual([
        "The provider factory of model lane failed: it did not return an object with generate and stream methods",
        "The provider factory of model lane failed: no credentials",
      ])
    }),
  )
})

// M1c-3. Each strict expectation below sits beside the tolerant input that real endpoints send, which must keep
// working. The event-stream rules come from the WHATWG HTML standard, section 9.2 Server-sent events, "Interpreting
// an event stream".
describe("openaiCompatible event stream", () => {
  const chunked = (parts: ReadonlyArray<Uint8Array>) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          for (const part of parts) controller.enqueue(part)
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  const streamOf = async (response: () => Response) =>
    collect(await openaiCompatible({ apiKey: "", fetch: transport(response).fetch }).stream(request))
  const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  // WHATWG: each data field appends its value and a newline to the data buffer, and dispatch drops the last newline,
  // so the data lines of one event are joined with a newline. JSON allows a newline wherever white space goes. The
  // last line also has no space after its colon, which the standard allows.
  it("joins the data lines of one event with a newline before it parses them", async () => {
    for (const eol of ["\n", "\r\n"]) {
      const body = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        "",
        'data: {"choices":[{"delta":',
        'data: {"content":"lo"},',
        'data:"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join(eol)
      expect(await streamOf(() => new Response(body))).toEqual([
        { type: "content-delta", delta: "Hel" },
        { type: "content-delta", delta: "lo" },
        { type: "content-done" },
        { type: "finish", finishReason: "stop", usage: zero },
      ])
    }
  })

  // Tolerant neighbors of the test above. Endpoints send `data:` with and without the space, CRLF line endings,
  // comment lines as keep-alives (WHATWG: a line that starts with a colon is ignored), and id or event fields that a
  // chat completions client has no use for. The single-line-event form without a blank line is covered by "reads each
  // data line as one event, with or without a blank line after it" above, and must still hold after the join.
  it("reads the event-stream forms that real endpoints send", async () => {
    const whole = await streamOf(() => sse(streamed))
    const lines = streamed.map((event) => JSON.stringify(event))
    const forms = [
      `${lines.map((line) => `data:${line}\n\n`).join("")}data:[DONE]\n\n`,
      `${lines.map((line) => `data: ${line}\r\n\r\n`).join("")}data: [DONE]\r\n\r\n`,
      `: OPENROUTER PROCESSING\n\n${lines.map((line) => `:keep-alive\ndata: ${line}\n\n`).join("")}data: [DONE]\n\n`,
      `${lines.map((line, index) => `id: ${index}\nevent: message\ndata: ${line}\n\n`).join("")}data: [DONE]\n\n`,
    ]
    for (const body of forms) expect(await streamOf(() => new Response(body))).toEqual(whole)
  })

  // Tolerant neighbor. TCP may cut an event anywhere, inside a field name, a line ending, or a multi-byte character.
  it("reads one small event split across network chunks at every byte position", async () => {
    const event = { choices: [{ delta: { content: "héllo ☃" }, finish_reason: "stop" }] }
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`)
    const expected = [
      { type: "content-delta", delta: "héllo ☃" },
      { type: "content-done" },
      { type: "finish", finishReason: "stop", usage: zero },
    ]
    for (let cut = 1; cut < bytes.length; cut++)
      expect(await streamOf(() => chunked([bytes.slice(0, cut), bytes.slice(cut)]))).toEqual(expected)
    const single = Array.from(bytes, (byte) => Uint8Array.of(byte))
    expect(await streamOf(() => chunked(single))).toEqual(expected)
  })
})

describe("openaiCompatible HTTP failures", () => {
  const failure = (status: number, headers: Record<string, string> = {}) =>
    openaiCompatible({ apiKey: "", fetch: async () => new Response("busy", { status, headers }) })
      .generate(request)
      .then(
        (response): ProviderError => {
          throw new Error(`generate resolved with ${JSON.stringify(response)}`)
        },
        (cause: ProviderError) => cause,
      )

  // RFC 9110 section 10.2.3: Retry-After = HTTP-date / delay-seconds, and HTTP-date is normally the IMF-fixdate that
  // Date.prototype.toUTCString writes. ProviderError.retryAfter is in seconds, which callModel turns into its delay.
  // The test reads the error and never sleeps. A date already past means no wait.
  it("turns a Retry-After that holds an HTTP date into the seconds until that date", async () => {
    const ahead = await failure(429, { "retry-after": new Date(Date.now() + 30_000).toUTCString() })
    expect([ahead.code, ahead.statusCode]).toEqual(["rate_limit", 429])
    expect(ahead.retryAfter).toBeGreaterThanOrEqual(25)
    expect(ahead.retryAfter).toBeLessThanOrEqual(30)
    const past = await failure(503, { "retry-after": new Date(Date.now() - 60_000).toUTCString() })
    expect(past.retryAfter).toBe(0)
  })

  // RFC 9110 section 10.2.3 allows only a date or a number of seconds. Anything else carries no delay, so retryAfter
  // stays unset and callModel falls back to its exponential backoff. An empty header is neither.
  it("ignores a Retry-After that holds neither a number nor a date", async () => {
    for (const value of ["soon", "", "later today", "-5"]) {
      const error = await failure(429, { "retry-after": value })
      expect([value, error.code, error.retryAfter]).toEqual([value, "rate_limit", undefined])
    }
  })

  // Tolerant neighbor of the two tests above. The numeric form keeps working, a fractional count included, which
  // RFC 9110 does not allow and which costs nothing to honor. A bare number must not be read as a date: Date.parse
  // reads "7" as a year.
  it("keeps a Retry-After that holds a number of seconds", async () => {
    for (const [value, seconds] of [
      ["0", 0],
      ["7", 7],
      ["1.5", 1.5],
    ] as const)
      expect([value, (await failure(429, { "retry-after": value })).retryAfter]).toEqual([value, seconds])
  })

  // HTTP 408 Request Timeout (RFC 9110 section 15.5.9) says the server gave up waiting for the request, so a repeat
  // may succeed. Providers section 7.1 names the timeout code "Request timed out" and marks it retryable.
  it("treats status 408 as a retryable timeout", async () => {
    const error = await failure(408)
    expect([error.code, error.statusCode, error.isRetryable, error.origin]).toEqual([
      "timeout",
      408,
      true,
      "provider:openai_compatible",
    ])
  })
})

describe("openaiCompatible responses", () => {
  // Providers sections 5 and 6 and ProviderUsage in @standardagents/spec 0.45.13 make usage and its three counts
  // required on a response and on a finish chunk, so a provider cannot leave usage out. What the types do let it
  // leave out are reasoningTokens, cachedTokens, cost, provider, and pricing, so none of them may appear as a zero.
  // This pins today's behavior.
  it("reports the required counts as zero and no optional count when the endpoint sends no usage", async () => {
    const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    const message = { content: "Hi." }
    const { fetch } = transport((entry) =>
      entry.body.stream === true
        ? sse([{ choices: [{ delta: message, finish_reason: "stop" }] }, { choices: [], usage: null }])
        : Response.json({ choices: [{ message, finish_reason: "stop" }] }),
    )
    const provider = openaiCompatible({ apiKey: "", fetch })
    expect((await provider.generate(request)).usage).toStrictEqual(zero)
    const finish = (await collect(await provider.stream(request))).at(-1)
    expect(finish?.type === "finish" ? finish.usage : undefined).toStrictEqual(zero)
    const bare = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: {} }
    const partial = openaiCompatible({
      apiKey: "",
      fetch: async () => Response.json({ choices: [{ message, finish_reason: "stop" }], usage: bare }),
    })
    expect((await partial.generate(request)).usage).toStrictEqual({
      promptTokens: 4,
      completionTokens: 2,
      totalTokens: 6,
    })
  })

  // Chat completions answers with a choices array whose first entry holds the message. A body with no choice is no
  // response at all, and Providers section 7 says "Providers throw typed errors for error conditions", so generate
  // throws a ProviderError rather than return an empty message that looks like a model that said nothing.
  it("rejects a generate response with no choice as a ProviderError", async () => {
    for (const body of [{}, { choices: [] }, null, []]) {
      const outcome = await openaiCompatible({ apiKey: "", fetch: async () => Response.json(body) })
        .generate(request)
        .then(
          (response) => `resolved with ${JSON.stringify(response)}`,
          (cause: ProviderError) => [cause.constructor.name, cause.origin],
        )
      expect([JSON.stringify(body), outcome]).toEqual([
        JSON.stringify(body),
        ["ProviderError", "provider:openai_compatible"],
      ])
    }
  })

  // Tolerant neighbor. A minimal body with one choice is a response even with no id, no usage, no role, and no
  // finish reason, and a choice whose content a filter removed is a response with null content, which the step loop
  // judges, not the provider.
  it("accepts a minimal generate response and one whose content was filtered", async () => {
    const minimal = openaiCompatible({
      apiKey: "",
      fetch: async () => Response.json({ choices: [{ message: { content: "Hi." } }] }),
    })
    expect(await minimal.generate(request)).toMatchObject({ content: "Hi.", finishReason: "stop" })
    const filtered = openaiCompatible({
      apiKey: "",
      fetch: async () =>
        Response.json({
          choices: [{ message: { role: "assistant", content: null }, finish_reason: "content_filter" }],
        }),
    })
    expect(await filtered.generate(request)).toMatchObject({ content: null, finishReason: "content_filter" })
  })
})

// ProviderToolCallPart.extraContent in @standardagents/spec 0.45.13: "Provider-specific metadata that must round-trip
// with the tool call", such as a thought signature that has to be echoed back on the next turn. On the chat
// completions wire of endpoints that send it, it is the extra_content member of a tool_calls entry, in a response
// message and in a streamed delta alike. DIVERGENCES.md, "Stream chunks that only the package declares", says that
// Spindle keeps extraContent in metadata.tool_call_extra and sends it back with the call.
describe("openaiCompatible extra_content", () => {
  const extra = { google: { thought_signature: "sig-1" } }
  const wireCall = (fields: Record<string, unknown>) => ({
    id: "call_g",
    type: "function",
    function: { name: "noop", arguments: "{}" },
    ...fields,
  })

  it("reads extra_content on a tool call from generate and stream", async () => {
    const message = { content: null, tool_calls: [wireCall({ extra_content: extra })] }
    const { fetch } = transport((entry) =>
      entry.body.stream === true
        ? sse([
            { choices: [{ delta: { tool_calls: [{ index: 0, ...wireCall({ extra_content: extra }) }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        : Response.json({ choices: [{ message, finish_reason: "tool_calls" }] }),
    )
    const provider = openaiCompatible({ apiKey: "", fetch })
    expect((await provider.generate(request)).toolCalls).toEqual([
      { id: "call_g", name: "noop", arguments: {}, extraContent: extra },
    ])
    // The package lets either tool-call-start or tool-call-done carry it, and callModel reads both.
    const carried = (await collect(await provider.stream(request))).flatMap((chunk) =>
      (chunk.type === "tool-call-start" || chunk.type === "tool-call-done") && chunk.id === "call_g"
        ? [chunk.extraContent]
        : [],
    )
    expect(carried).toContainEqual(extra)
  })

  it("sends extraContent back as extra_content on the tool call it came with", () => {
    const body = requestBody(
      {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: null,
            toolCalls: [
              { id: "call_g", name: "noop", arguments: {}, extraContent: extra },
              { id: "call_h", name: "noop", arguments: {} },
            ],
          },
        ],
      },
      false,
    )
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_g", type: "function", function: { name: "noop", arguments: "{}" }, extra_content: extra },
          { id: "call_h", type: "function", function: { name: "noop", arguments: "{}" } },
        ],
      },
    ])
  })

  // Tolerant neighbor. A call without extra_content, or with a null one, carries no extraContent.
  it("gives no extraContent to a call that arrives without an object in extra_content", async () => {
    const message = { content: null, tool_calls: [wireCall({}), wireCall({ id: "call_n", extra_content: null })] }
    const { fetch } = transport((entry) =>
      entry.body.stream === true
        ? sse([
            { choices: [{ delta: { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        : Response.json({ choices: [{ message, finish_reason: "tool_calls" }] }),
    )
    const provider = openaiCompatible({ apiKey: "", fetch })
    for (const call of (await provider.generate(request)).toolCalls ?? [])
      expect(call).not.toHaveProperty("extraContent")
    for (const chunk of await collect(await provider.stream(request))) expect(chunk).not.toHaveProperty("extraContent")
  })

  // The whole trip through the runtime: the endpoint sends extra_content, the step loop stores the call, runs the
  // tool, and the next request carries extra_content on that call.
  it("carries extra_content from a streamed response to the next request through a run", async () => {
    const { sent, fetch } = transport(() =>
      sent.length === 1
        ? sse([
            { choices: [{ delta: { tool_calls: [{ index: 0, ...wireCall({ extra_content: extra }) }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ])
        : sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
    )
    const tools = { noop: defineTool({ description: "Does nothing", execute: async () => ok("noop") }) }
    const model = { provider: (config: { apiKey: string }) => openaiCompatible({ ...config, apiKey: "", fetch }) }
    await using(spindleDriver, { provider: new ScriptedProvider([]), model, tools }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
      const assistant = (await session.messages(thread)).find((message) => message.role === "assistant")
      expect(assistant?.metadata).toMatchObject({ tool_call_extra: { call_g: extra } })
    })
    expect(sent).toHaveLength(2)
    const replayed = ((sent[1]?.body.messages ?? []) as Array<Record<string, unknown>>).find(
      (message) => message.role === "assistant",
    )
    expect(replayed?.tool_calls).toEqual([
      { id: "call_g", type: "function", function: { name: "noop", arguments: "{}" }, extra_content: extra },
    ])
  })
})

describe("openaiCompatible request fields", () => {
  // ProviderRequest.user in @standardagents/spec 0.45.13: "Providers that support it (OpenAI-compatible `user`; ...)
  // should forward it". The spec text's ProviderRequest has no user, and DIVERGENCES.md records that the runtime sets
  // none yet. This tests the provider: a request that carries user sends it as the chat completions user field.
  it("forwards the request's user as the chat completions user field", () => {
    for (const stream of [false, true])
      expect(requestBody({ ...request, user: "thread-1" }, stream)).toMatchObject({ user: "thread-1" })
  })

  // Tolerant neighbor. A request without user sends none, and a user that only providerOptions names still goes out
  // as Providers section 2.1 merges providerOptions.
  it("sends no user when the request has none, and keeps one that providerOptions sets", () => {
    expect(requestBody({ model: "m", messages: [] }, true)).not.toHaveProperty("user")
    expect(requestBody({ model: "m", messages: [], providerOptions: { user: "operator" } }, false)).toMatchObject({
      user: "operator",
    })
  })

  // Providers section 2.1: the merged providerOptions apply as they are, and a key the provider sets itself replaces
  // only that key. The provider needs stream_options.include_usage to read usage from a stream, and a sibling that
  // providerOptions puts in stream_options, such as include_obfuscation, must survive beside it.
  it("keeps a providerOptions stream_options sibling beside include_usage", () => {
    const body = requestBody(
      { model: "m", messages: [], providerOptions: { stream_options: { include_obfuscation: false } } },
      true,
    )
    expect(body.stream_options).toEqual({ include_obfuscation: false, include_usage: true })
  })

  // Prompts section 6.1 lets a prompt set reasoning.maxTokens, and chat completions has no common field for a reasoning
  // token budget. The ledger reason for specification:prompts:132940db says "openaiCompatible sends none". This pins
  // that: the budget appears nowhere in the body, alone or beside a level.
  it("sends no reasoning token budget", () => {
    for (const reasoning of [
      { maxTokens: 4093 },
      { level: 66, levels: { 33: "low", 66: "medium" }, maxTokens: 4093 },
    ]) {
      const body = requestBody({ model: "m", messages: [], reasoning }, true)
      expect(JSON.stringify(body)).not.toContain("4093")
      expect(body).not.toHaveProperty("reasoning")
      expect(body).not.toHaveProperty("max_tokens")
    }
  })
})
