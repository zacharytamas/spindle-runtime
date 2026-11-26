import { describe, expect, it } from "@effect/vitest"
import { redactor, redactText } from "../../src/execution/redact.ts"

describe("redactText", () => {
  const redact = redactText(redactor(new Set(["sum", 'a"b'])))

  it("changes only the string values of text that holds JSON and keeps its keys, numbers, and layout", () => {
    const text = '{\n  "summary": "the sum",\n  "total": 1.50,\n  "sum": ["a\\"b", true, null],\n  "kept": "\\u00e9"\n}'
    const redacted = redact(text)
    expect(redacted).toBe(
      '{\n  "summary": "the [redacted]",\n  "total": 1.50,\n  "sum": ["[redacted]", true, null],\n  "kept": "\\u00e9"\n}',
    )
    expect(Object.keys(JSON.parse(redacted))).toEqual(["summary", "total", "sum", "kept"])
  })

  it("redacts every occurrence in text that does not hold a JSON object or array", () => {
    expect(redact('the sum of a"b and a\\"b')).toBe("the [redacted] of [redacted] and [redacted]")
    expect(redact('"summary"')).toBe('"[redacted]mary"')
  })
})
