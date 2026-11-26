import { describe, expect, it } from "vitest"
import { scriptedProvider } from "../../src/providers/script.ts"

const request = { model: "m", messages: [] }

describe("scriptedProvider", () => {
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
