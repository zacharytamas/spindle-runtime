import type { ProviderStreamChunk } from "@standardagents/spec"
import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { decodeScript, scriptedProvider } from "../../src/providers/script.ts"

const request = { model: "m", messages: [] }

describe("scriptedProvider", () => {
  it.each(["statusCode", "retryAfter"])("rejects an overflowing JSON number in %s", async (field) => {
    const text = `{"responses":[{"error":{"message":"busy","${field}":1e400}}]}`
    expect(Exit.isFailure(await Effect.runPromiseExit(decodeScript(text)))).toBe(true)
  })

  it("returns from generate the text, calls, finish, and usage that stream yields for the same response", async () => {
    const chunks: Array<ProviderStreamChunk> = [
      { type: "content-delta", delta: "Looking." },
      { type: "tool-call-start", id: "c1", name: "lookup" },
      { type: "tool-call-done", id: "c1", arguments: { q: "rain" } },
      { type: "finish", finishReason: "tool_calls", usage: { promptTokens: 6, completionTokens: 3, totalTokens: 9 } },
    ]
    const provider = scriptedProvider({ responses: [{ chunks }], repeat: true })
    const streamed: Array<ProviderStreamChunk> = []
    for await (const chunk of await provider.stream(request)) streamed.push(chunk)
    expect(streamed).toEqual(chunks)
    expect(await provider.generate(request)).toEqual({
      content: "Looking.",
      toolCalls: [{ id: "c1", name: "lookup", arguments: { q: "rain" } }],
      finishReason: "tool_calls",
      usage: { promptTokens: 6, completionTokens: 3, totalTokens: 9 },
    })
  })

  it("fails generate, like stream, for a response that has no finish chunk or that ends in an error chunk", async () => {
    const provider = scriptedProvider({
      responses: [
        { chunks: [{ type: "content-delta", delta: "half" }] },
        { chunks: [{ type: "error", error: "overloaded", code: "rate_limit" }] },
      ],
    })
    const failures = [
      await provider.generate(request).catch((cause) => cause),
      await provider.generate(request).catch((cause) => cause),
    ]
    expect(failures.map((error) => [error.constructor.name, error.code, error.isRetryable])).toEqual([
      ["ProviderError", "server_error", true],
      ["ProviderError", "rate_limit", true],
    ])
  })
})
