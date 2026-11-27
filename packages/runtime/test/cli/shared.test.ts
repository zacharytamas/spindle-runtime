import { describe, expect, it } from "vitest"
import { holdNote } from "../../src/cli/shared.ts"
import { redactor } from "../../src/execution/redact.ts"

describe("holdNote", () => {
  it("advises a tool time limit for a tool even when a secret is the word that names the kind", () => {
    const text = holdNote("t1", "tool hold", redactor(new Set(["tool"])), "abort and exit")
    expect(text).toBe(
      "[redacted] hold has not returned. Thread t1 stays held until it returns. Press Ctrl-C twice to abort and exit. Use --tool-timeout to bound tool calls.",
    )
  })

  it("says that a hook ends at its time limit", () => {
    expect(holdNote("t1", "hook gate", (text) => text, "abort and exit")).toBe(
      "hook gate has not returned. Thread t1 stays held until it returns or reaches its time limit. Press Ctrl-C twice to abort and exit.",
    )
  })
})
