import type { PromptSide } from "@standardagents/spec"
import { describe, expect, it } from "vitest"
import { STOP_RULES, type StepFacts, stopReason } from "../../src/execution/stop-rules.ts"

const side = (extra: Partial<PromptSide> = {}): PromptSide => ({ prompt: "assistant", ...extra })

const step = (extra: Partial<StepFacts> = {}): StepFacts => ({
  text: null,
  calls: [],
  sideSteps: 1,
  totalSteps: 1,
  ...extra,
})

const finish = [{ name: "finish" }]

describe("stop rules", () => {
  it("orders the rules stopTool, stopOnResponse, maxSteps, then the runtime step cap", () => {
    expect(STOP_RULES.map((rule) => rule.reason)).toEqual([
      "stop_tool",
      "stop_on_response",
      "max_side_steps",
      "max_total_steps",
    ])
  })

  it("stop_tool matches a step that calls the side's stopTool, and no other step", () => {
    expect(stopReason(step({ calls: [{ name: "note" }, ...finish] }), side({ stopTool: "finish" }), 100)).toBe(
      "stop_tool",
    )
    expect(stopReason(step({ calls: [{ name: "note" }] }), side({ stopTool: "finish" }), 100)).toBeUndefined()
    expect(stopReason(step({ calls: finish }), side(), 100)).toBeUndefined()
  })

  it("stop_on_response matches text without calls by default, and never empty text, calls, or a false setting", () => {
    expect(stopReason(step({ text: "hello" }), side(), 100)).toBe("stop_on_response")
    expect(stopReason(step({ text: "hello" }), side({ stopOnResponse: true }), 100)).toBe("stop_on_response")
    expect(stopReason(step({ text: "hello" }), side({ stopOnResponse: false }), 100)).toBeUndefined()
    expect(stopReason(step({ text: "hello", calls: [{ name: "note" }] }), side(), 100)).toBeUndefined()
    for (const text of [null, "", " \n"]) expect(stopReason(step({ text }), side(), 100)).toBeUndefined()
  })

  it("max_side_steps matches once the side has taken maxSteps steps", () => {
    expect(stopReason(step({ calls: [{ name: "note" }], sideSteps: 3 }), side({ maxSteps: 3 }), 100)).toBe(
      "max_side_steps",
    )
    expect(stopReason(step({ calls: [{ name: "note" }], sideSteps: 2 }), side({ maxSteps: 3 }), 100)).toBeUndefined()
  })

  it("max_total_steps matches once the execution reaches the runtime step cap", () => {
    expect(stopReason(step({ calls: [{ name: "note" }], totalSteps: 100 }), side(), 100)).toBe("max_total_steps")
    expect(stopReason(step({ calls: [{ name: "note" }], totalSteps: 99 }), side(), 100)).toBeUndefined()
  })

  it("stop_tool wins over max_side_steps when both match", () => {
    expect(stopReason(step({ calls: finish, sideSteps: 1 }), side({ stopTool: "finish", maxSteps: 1 }), 100)).toBe(
      "stop_tool",
    )
  })

  it("stop_tool wins over max_total_steps when both match", () => {
    expect(stopReason(step({ calls: finish, totalSteps: 5 }), side({ stopTool: "finish" }), 5)).toBe("stop_tool")
  })

  it("stop_on_response wins over max_side_steps when both match", () => {
    expect(stopReason(step({ text: "done", sideSteps: 1 }), side({ maxSteps: 1 }), 100)).toBe("stop_on_response")
  })

  it("stop_on_response wins over max_total_steps when both match", () => {
    expect(stopReason(step({ text: "done", totalSteps: 5 }), side(), 5)).toBe("stop_on_response")
  })

  it("max_side_steps wins over max_total_steps when both match", () => {
    expect(stopReason(step({ calls: [{ name: "note" }], sideSteps: 5, totalSteps: 5 }), side({ maxSteps: 5 }), 5)).toBe(
      "max_side_steps",
    )
  })

  it("stop_tool and stop_on_response never match one step, because a response stop needs a step without calls", () => {
    const both = side({ stopTool: "finish" })
    expect(stopReason(step({ text: "done", calls: finish }), both, 100)).toBe("stop_tool")
    expect(STOP_RULES[1]?.applies(step({ text: "done", calls: finish }), both, 100)).toBe(false)
  })
})
