import { defineTool, ProviderError, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, ok, type Scenario, sideOf, stubTool, toolResults, using } from "../harness.ts"
import { probeTool, usingDual } from "./fixtures.ts"

const ref = {
  id: "att_1",
  type: "file" as const,
  path: "/notes/a.txt",
  name: "a.txt",
  mimeType: "text/plain",
  size: 10,
}

export const T01: Scenario = {
  name: "T01 (rules 1, 2, 4, 5, 32) alternates prompt x prompt A to B to A with reused tool call IDs and independent step counts",
  requirements: ["b8f7cd7e", "853d2427", "ffcb95d1", "77517ef7", "5c3c3e89", "0700c380", "903da2e2", "7d581abd"],
  run: async (driver) => {
    const probes: Array<unknown> = []
    let workRuns = 0
    const tools = {
      work_tool: probeTool(probes, () => `work-${++workRuns}`),
      review_tool: probeTool(probes, () => "review-1"),
    }
    const providerA = new ScriptedProvider([
      { text: "working", toolCalls: [{ id: "shared_id", name: "work_tool", arguments: {} }] },
      { text: "draft ready" },
      { toolCalls: [{ id: "shared_id", name: "work_tool", arguments: {} }] },
      { text: "final draft" },
    ])
    const providerB = new ScriptedProvider([
      { text: "checking", toolCalls: [{ id: "shared_id", name: "review_tool", arguments: {} }] },
      { text: "needs revision" },
    ])
    const flags = { includeChat: true, includePastTools: true }
    await usingDual(
      driver,
      {
        providerA,
        providerB,
        tools,
        promptA: { ...flags, tools: ["work_tool"] },
        promptB: { ...flags, tools: ["review_tool"] },
        agent: { maxSessionTurns: 3 },
      },
      async (session, thread) => {
        expect(await session.send(thread, "start task")).toMatchObject({
          status: "idle",
          reason: "max_session_turns",
          steps: 6,
        })
        const stored = await session.messages(thread)
        expect(stored.map((m) => [m.role, m.content, m.prompt])).toEqual([
          ["user", "start task", null],
          ["assistant", "working", "worker"],
          ["tool", "work-1", "worker"],
          ["assistant", "draft ready", "worker"],
          ["user", "checking", "reviewer"],
          ["tool", "review-1", "reviewer"],
          ["user", "needs revision", "reviewer"],
          ["assistant", null, "worker"],
          ["tool", "work-2", "worker"],
          ["assistant", "final draft", "worker"],
        ])
        const inspected = (await session.inspect(thread)).messages
        const callers = inspected.filter((m) => m.role !== "tool" && m.content !== "start task")
        expect(toolResults(inspected).map((m) => m.callerSeq)).toEqual([
          callers[0]?.seq,
          callers[2]?.seq,
          callers[4]?.seq,
        ])
      },
    )
    const flows = probes.map((p) => (p as Array<unknown>)[0])
    expect(typeof flows[0]).toBe("string")
    expect(flows).toEqual([flows[0], flows[0], flows[0]])
    expect(probes.map((p) => (p as Array<unknown>).slice(1))).toEqual([
      ["a", ["worker"], 1, 1, 0],
      ["b", ["reviewer"], 3, 2, 1],
      ["a", ["worker"], 5, 3, 2],
    ])
    expect(history(providerB.requests[0]).map(sideOf)).toEqual([
      ["assistant", "start task", []],
      ["user", "working"],
      ["user", "draft ready"],
    ])
    expect(history(providerB.requests[1]).map(sideOf)).toEqual([
      ["assistant", "start task", []],
      ["user", "working"],
      ["user", "draft ready"],
      ["assistant", "checking", ["shared_id"]],
      ["tool", "shared_id"],
    ])
    expect(toolResults(history(providerB.requests[1])).map((m) => m.content)).toEqual(["review-1"])
    expect(JSON.stringify(providerB.requests)).not.toMatch(/work_tool|work-1|work-2/)
    expect(history(providerA.requests[2]).map(sideOf)).toEqual([
      ["user", "start task"],
      ["assistant", "working", ["shared_id"]],
      ["tool", "shared_id"],
      ["assistant", "draft ready", []],
      ["user", "checking"],
      ["user", "needs revision"],
    ])
    expect(toolResults(history(providerA.requests[3])).map((m) => m.content)).toEqual(["work-1", "work-2"])
    expect(JSON.stringify(providerA.requests)).not.toMatch(/review_tool|review-1/)
  },
}

export const T02: Scenario = {
  name: "T02 (rule 3) hides opposite-side tool-call-only messages without text or attachments on both sides",
  requirements: ["853d2427", "43bbb05d"],
  run: async (driver) => {
    const tools = { work: stubTool("Work", "worked"), check: stubTool("Check", "checked") }
    const providerA = new ScriptedProvider([
      { toolCalls: [{ id: "a_only", name: "work", arguments: {} }] },
      { text: "with call", toolCalls: [{ id: "a_text", name: "work", arguments: {} }] },
      { text: "A done" },
      { text: "finished" },
    ])
    const providerB = new ScriptedProvider([
      { toolCalls: [{ id: "b_only", name: "check", arguments: {} }] },
      { text: "B done" },
    ])
    const flags = { includeChat: true, includePastTools: true }
    await usingDual(
      driver,
      {
        providerA,
        providerB,
        tools,
        promptA: { ...flags, tools: ["work"] },
        promptB: { ...flags, tools: ["check"] },
        agent: { maxSessionTurns: 3 },
      },
      async (session, thread) => {
        const callJson = (id: string) =>
          JSON.stringify([{ id, type: "function", function: { name: "work", arguments: "{}" } }])
        await session.seed(thread, [
          { role: "assistant", content: "", tool_calls: callJson("seed_empty") },
          { role: "tool", content: "seed empty", name: "work", tool_call_id: "seed_empty", tool_status: "success" },
          { role: "assistant", content: null, attachments: [ref], tool_calls: callJson("seed_att") },
          { role: "tool", content: "seed att", name: "work", tool_call_id: "seed_att", tool_status: "success" },
        ])
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "max_session_turns" })
      },
    )
    expect(history(providerB.requests[0]).map(sideOf)).toEqual([
      ["user", "[Attachment a.txt (text/plain) at /notes/a.txt]"],
      ["assistant", "go", []],
      ["user", "with call"],
      ["user", "A done"],
    ])
    expect(history(providerA.requests[3]).map(sideOf).slice(-2)).toEqual([
      ["assistant", "A done", []],
      ["user", "B done"],
    ])
    for (const request of [...providerA.requests, ...providerB.requests])
      expect(history(request).filter((m) => m.role === "user" && m.content === "")).toEqual([])
    // Also verify opposite-side tool-call-only omission on a single-prompt agent with seeded human-side tool calls.
    const single = new ScriptedProvider([{ text: "ok" }])
    await using(driver, { provider: single, prompt: { includeChat: true } }, async (session, thread) => {
      const callJson = JSON.stringify([{ id: "h1", type: "function", function: { name: "other", arguments: "{}" } }])
      await session.seed(thread, [
        { role: "user", content: null, tool_calls: callJson },
        { role: "tool", content: "hidden", name: "other", tool_call_id: "h1", tool_status: "success" },
      ])
      await session.send(thread, "hello")
    })
    expect(history(single.requests[0]).map(sideOf)).toEqual([["user", "hello"]])
  },
}

export const T03: Scenario = {
  name: "T03 (rules 11, 31) pauses prompt-side draining at a queue head targeting the opposite prompt side",
  requirements: ["109134a1", "5012a6bc", "b8f7cd7e"],
  run: async (driver) => {
    const queue_items = defineTool({
      description: "Queue entries targeting A, B, then A",
      execute: async (state: ThreadState) => {
        await state.queueMessage({ role: "user", content: "for A" })
        await state.queueMessage({ role: "assistant", content: "for B" })
        await state.queueMessage({ role: "user", content: "after B" })
        return ok("queued")
      },
    })
    const providerA = new ScriptedProvider([
      { toolCalls: [{ id: "c_q", name: "queue_items", arguments: {} }] },
      { text: "A done" },
    ])
    const providerB = new ScriptedProvider([{ text: "B done" }])
    await usingDual(
      driver,
      {
        providerA,
        providerB,
        tools: { queue_items },
        promptA: { includeChat: true, tools: ["queue_items"] },
        promptB: { includeChat: true, tools: [] },
        agent: { maxSessionTurns: 2 },
      },
      async (session, thread) => {
        expect(await session.send(thread, "start")).toMatchObject({
          status: "idle",
          reason: "max_session_turns",
          steps: 3,
        })
        const remaining = (await session.inspect(thread)).queue.map(
          (entry) => (JSON.parse(entry.payload) as { content?: string }).content,
        )
        expect(remaining).toEqual(["after B"])
      },
    )
    expect(history(providerA.requests[1]).map(sideOf)).toEqual([
      ["user", "start"],
      ["assistant", null, ["c_q"]],
      ["tool", "c_q"],
      ["user", "for A"],
    ])
    expect(history(providerB.requests[0]).map(sideOf)).toEqual([
      ["assistant", "start", []],
      ["assistant", "for A", []],
      ["user", "A done"],
      ["user", "for B"],
    ])
  },
}

export const T04: Scenario = {
  name: "T04 (rules 12, §3) fails on a provider error mid-turn on side B, preserves side A's turn, and resets session_turns",
  requirements: ["47d9e86c", "37e4432c", "7029c151"],
  run: async (driver) => {
    const tools = { check: stubTool("Check", "checked") }
    const providerA = new ScriptedProvider([{ text: "A1" }, { text: "A2" }])
    const providerB = new ScriptedProvider([
      { toolCalls: [{ id: "b_c1", name: "check", arguments: {} }] },
      { reject: new ProviderError("side B provider down", "invalid_request") },
      { text: "B2" },
    ])
    await usingDual(
      driver,
      {
        providerA,
        providerB,
        tools,
        promptA: { includeChat: true, tools: [] },
        promptB: { includeChat: true, tools: ["check"] },
        agent: { maxSessionTurns: 2 },
      },
      async (session, thread) => {
        const failed = await session.send(thread, "first")
        expect(failed).toMatchObject({ status: "failed", reason: "step_error", steps: 2 })
        expect((await session.messages(thread)).map((m) => [m.role, m.content])).toEqual([
          ["user", "first"],
          ["assistant", "A1"],
          ["user", null],
          ["tool", "checked"],
        ])
        // session_turns reset to 0 on step_error, so the next session runs a full 2 turns (A2 then B2).
        const next = await session.send(thread, "second")
        expect(next).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 2 })
        expect((await session.messages(thread)).slice(-3).map((m) => [m.role, m.content])).toEqual([
          ["user", "second"],
          ["assistant", "A2"],
          ["user", "B2"],
        ])
      },
    )
  },
}
