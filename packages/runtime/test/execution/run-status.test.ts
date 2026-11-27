import type { ThreadStatus } from "@standardagents/spec"
import { describe, expect, it } from "vitest"
import { type RunEvent, TRANSITIONS, transition } from "../../src/execution/run-status.ts"

const NOW = 1_764_000_000_000_000

const at = {
  neverRan: { state: "idle", since: 0, reason: null },
  idle: { state: "idle", since: 10, reason: "stop_on_response" },
  running: { state: "running", since: 20, reason: null },
  failed: { state: "failed", since: 30, reason: "step_error" },
} satisfies Record<string, ThreadStatus>

const start: RunEvent = { type: "start" }
const idle = (reason: string): RunEvent => ({ type: "settle", state: "idle", reason })
const failed = (reason: string): RunEvent => ({ type: "settle", state: "failed", reason })
const lose: RunEvent = { type: "lose" }

describe("run status transitions", () => {
  describe("legal", () => {
    it("start from a thread that never ran sets running with reason null and a new since", () => {
      expect(transition(at.neverRan, start, NOW)).toEqual({ state: "running", since: NOW, reason: null })
    })

    it("start from idle sets running with reason null and a new since", () => {
      expect(transition(at.idle, start, NOW)).toEqual({ state: "running", since: NOW, reason: null })
    })

    it("start from failed sets running, which is how a recovery run begins", () => {
      expect(transition(at.failed, start, NOW)).toEqual({ state: "running", since: NOW, reason: null })
    })

    it("settle idle from running records the stop reason and a new since", () => {
      expect(transition(at.running, idle("awaiting_human"), NOW)).toEqual({
        state: "idle",
        since: NOW,
        reason: "awaiting_human",
      })
    })

    it("settle failed from running records the failure reason and a new since", () => {
      expect(transition(at.running, failed("fatal_error"), NOW)).toEqual({
        state: "failed",
        since: NOW,
        reason: "fatal_error",
      })
    })

    it("lose from running settles failed with execution_lost", () => {
      expect(transition(at.running, lose, NOW)).toEqual({ state: "failed", since: NOW, reason: "execution_lost" })
    })

    it("passes a reason code that the spec does not list through unchanged in either state", () => {
      expect(transition(at.running, idle("spindle_custom"), NOW)?.reason).toBe("spindle_custom")
      expect(transition(at.running, failed("spindle_custom"), NOW)?.reason).toBe("spindle_custom")
    })
  })

  describe("illegal", () => {
    it("start from running, so a second execution of a running thread cannot begin", () => {
      expect(transition(at.running, start, NOW)).toBeUndefined()
    })

    it("settle idle from idle", () => {
      expect(transition(at.idle, idle("stop_on_response"), NOW)).toBeUndefined()
    })

    it("settle failed from idle", () => {
      expect(transition(at.idle, failed("step_error"), NOW)).toBeUndefined()
    })

    it("lose from idle", () => {
      expect(transition(at.neverRan, lose, NOW)).toBeUndefined()
    })

    it("settle idle from failed", () => {
      expect(transition(at.failed, idle("stop_on_response"), NOW)).toBeUndefined()
    })

    it("settle failed from failed", () => {
      expect(transition(at.failed, failed("step_error"), NOW)).toBeUndefined()
    })

    it("lose from failed", () => {
      expect(transition(at.failed, lose, NOW)).toBeUndefined()
    })

    it("settle idle with a code that Execution State section 4.2 lists for failed", () => {
      expect(transition(at.running, idle("execution_lost"), NOW)).toBeUndefined()
    })

    it("settle failed with a code that Execution State section 4.2 lists for idle", () => {
      expect(transition(at.running, failed("stop_on_response"), NOW)).toBeUndefined()
    })
  })

  it("lists exactly the five legal pairs that the cases above cover", () => {
    expect(
      Object.entries(TRANSITIONS).flatMap(([state, events]) => events.map((event) => `${state} ${event}`)),
    ).toEqual(["idle start", "failed start", "running settle idle", "running settle failed", "running lose"])
  })
})
