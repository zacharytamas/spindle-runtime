import { describe, expect, it } from "@effect/vitest"
import {
  defineModel,
  defineProvider,
  type ProviderError,
  type ProviderFactoryWithOptions,
  type ProviderReasoningDetail,
  type ProviderRequest,
  type ProviderStreamChunk,
  providerEnv,
} from "@standardagents/spec"
import { ConfigProvider, Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/http"
import { SetupError } from "../../src/execution/turn.ts"
import { providerFor } from "../../src/providers/config.ts"
import { openaiCompatible, requestBody } from "../../src/providers/openai-compatible.ts"

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
          { delta: { content: "Done.", reasoning_details: [{ ...wire[1], index: 1 }] }, finish_reason: "stop" },
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
    definition: {
      kind: "model" as const,
      name: "lane",
      qualifiedName: "lane",
      package: undefined,
      file: "memory",
      path: "",
      load: Effect.void,
    },
    value: defineModel({ name: "lane", provider, model: "native-model" }),
  })
  const build = (provider: ProviderFactoryWithOptions, env: Record<string, string>) => {
    const { sent, fetch } = transport(() => Response.json(generated))
    const secrets = new Set<string>()
    return Effect.gen(function* () {
      const instance = yield* yield* providerFor(loaded(provider), {} as never, secrets)
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
      expect([...secrets]).toEqual(["lane-key"])
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
      expect([...withEnv.secrets]).toEqual(["env-key"])
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
      const next = yield* providerFor(loaded(perRequest), state as never, new Set())
      for (const _ of [1, 2]) {
        const instance = yield* next
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
      const instance = yield* yield* providerFor(loaded(overridden), state as never, new Set()).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
      )
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
        const exit = yield* Effect.exit(providerFor(loaded(factory as never), {} as never, new Set()))
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
