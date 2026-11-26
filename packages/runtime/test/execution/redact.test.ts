import { describe, expect, it } from "@effect/vitest"
import { redactor } from "../../src/execution/redact.ts"

describe("redactor", () => {
  const redact = redactor(new Set(["sum", 'a"b']))

  it("replaces a secret wherever it appears in text that holds JSON, property names included", () => {
    expect(redact('{"summary": "the sum", "sum": ["a\\"b"]}')).toBe(
      '{"[redacted]mary": "the [redacted]", "[redacted]": ["[redacted]"]}',
    )
  })

  it("replaces a secret as written and once JSON-escaped, the longer secret first", () => {
    expect(redact('the sum of a"b and a\\"b')).toBe("the [redacted] of [redacted] and [redacted]")
    expect(redactor(new Set(["ab", "abc"]))("abcd")).toBe("[redacted]d")
  })
})
