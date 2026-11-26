import { defineTool, type Message, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import type { RunOutcome } from "../../RuntimeDriver.ts"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { firstToolResult, ok, runTurn, type Scenario, shape, stubTool, toolResults, using } from "../harness.ts"

export const S17: Scenario = {
  name: "S17 stops a turn on a text response without tool calls and only then, unless stopOnResponse is false",
  requirements: ["13b3351a", "47ded442", "7aa29e92"],
  run: async (driver) => {
    const tools = { act: stubTool("Act", "acted") }
    const mixed = new ScriptedProvider([
      { text: "Working on it", toolCalls: [{ id: "c1", name: "act", arguments: {} }] },
      { text: "Finished" },
    ])
    await using(driver, { provider: mixed, tools }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({
        status: "idle",
        reason: "stop_on_response",
        steps: 2,
      })
      expect(shape(await session.messages(thread))).toEqual([
        ["user", "go"],
        ["assistant", "Working on it"],
        ["tool", "c1"],
        ["assistant", "Finished"],
      ])
    })
    const text = new ScriptedProvider([{ text: "Hello" }, { text: "never asked" }])
    expect(await runTurn(driver, { provider: text, tools }, "hi")).toMatchObject({
      reason: "stop_on_response",
      steps: 1,
    })
    expect(text.requests).toHaveLength(1)
    const chatty = new ScriptedProvider([{ text: "one" }, { text: "two" }, { text: "three" }])
    expect(
      await runTurn(driver, { provider: chatty, tools, side: { stopOnResponse: false, maxSteps: 2 } }, "hi"),
    ).toMatchObject({ reason: "max_side_steps", steps: 2 })
    expect(chatty.requests).toHaveLength(2)
  },
}

export const S18: Scenario = {
  name: "S18 stops after the step that calls the stop tool, runs every call of that step, and reports the outcome",
  requirements: ["60822bc8", "77195da7", "e70c9393"],
  run: async (driver) => {
    const tools = {
      finish: defineTool({
        description: "Finish",
        args: z.object({ summary: z.string() }),
        execute: async (_state, { summary }) => ok(JSON.stringify({ summary: `${summary}, reported`, extra: 1 })),
      }),
      note: stubTool("Note", "noted"),
    }
    const first = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c_finish", name: "finish", arguments: { summary: "all done" } },
          { id: "c_note", name: "note", arguments: {} },
        ],
      },
      { text: "never asked" },
    ])
    await using(
      driver,
      { provider: first, tools, side: { stopTool: "finish", stopToolResponseProperty: "summary" } },
      async (session, thread) => {
        const outcome = await session.send(thread, "go")
        expect(outcome).toMatchObject({
          status: "idle",
          reason: "stop_tool",
          steps: 1,
          stopTool: { tool: "finish", callId: "c_finish", status: "success", value: "all done, reported" },
        })
        expect(shape(await session.messages(thread)).slice(2)).toEqual([
          ["tool", "c_finish"],
          ["tool", "c_note"],
        ])
      },
    )
    expect(first.requests).toHaveLength(1)
    const later = new ScriptedProvider([
      { toolCalls: [{ name: "note", arguments: {} }] },
      { toolCalls: [{ name: "finish", arguments: { summary: "second" } }] },
      { text: "never asked" },
    ])
    const outcome = await runTurn(driver, { provider: later, tools, side: { stopTool: "finish" } }, "go")
    expect(outcome).toMatchObject({ reason: "stop_tool", steps: 2 })
    expect(outcome.stopTool?.value).toBe(JSON.stringify({ summary: "second, reported", extra: 1 }))
    expect(later.requests).toHaveLength(2)
  },
}

export const S18b: Scenario = {
  name: "S18b reads the stop property before redaction, so a secret inside the property name cannot hide it",
  requirements: ["e70c9393"],
  run: async (driver) => {
    const stopWith = async (summary: string) => {
      const tools = {
        finish: defineTool({
          description: "Finish",
          variables: [{ name: "MARK", type: "secret", required: true, description: "A short secret" }],
          execute: async () => ok(JSON.stringify({ summary, count: 2 })),
        }),
      }
      const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_finish", name: "finish", arguments: {} }] }])
      let outcome: RunOutcome | undefined
      let stored: Message | undefined
      await using(
        driver,
        { provider, tools, side: { stopTool: "finish", stopToolResponseProperty: "summary" } },
        async (session, thread) => {
          outcome = await session.send(thread, "go")
          stored = firstToolResult(await session.messages(thread))
        },
        { instanceEnv: { MARK: "sum" } },
      )
      return { value: outcome?.stopTool?.value, content: stored?.content }
    }
    expect(await stopWith("valid")).toEqual({ value: "valid", content: '{"[redacted]mary":"valid","count":2}' })
    expect(await stopWith("the sum is 4")).toEqual({
      value: "the [redacted] is 4",
      content: '{"[redacted]mary":"the [redacted] is 4","count":2}',
    })
  },
}

export const S18c: Scenario = {
  name: "S18c reports the stored stop tool status when an attachment is dropped",
  requirements: ["e70c9393"],
  run: async (driver) => {
    const tools = {
      finish: defineTool({
        description: "Finish",
        execute: async () => ({ status: "success", result: '{"summary":"done"}', attachments: [null] }) as never,
      }),
    }
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "finish", arguments: {} }] }])
    await using(
      driver,
      { provider, tools, side: { stopTool: "finish", stopToolResponseProperty: "summary" } },
      async (session, thread) => {
        const outcome = await session.send(thread, "go")
        const stored = firstToolResult(await session.messages(thread))
        expect(stored?.tool_status).toBe("error")
        expect(outcome.stopTool).toMatchObject({ status: stored?.tool_status, value: "done" })
      },
    )
  },
}

export const S19: Scenario = {
  name: "S19 counts maxSteps per side and per turn and exposes the counters to tools",
  requirements: ["d80e4c71", "bc5ba253", "c5ab8a06", "ffcb95d1", "77517ef7", "5c3c3e89", "0700c380", "903da2e2"],
  run: async (driver) => {
    const probes: Array<unknown> = []
    const tools = {
      probe: defineTool({
        description: "Report execution state",
        execute: async (state: ThreadState) => {
          const execution = state.execution
          probes.push([
            execution?.currentSide,
            execution?.promptPath,
            execution?.stepCount,
            execution?.sideAStepCount,
            execution?.sideBStepCount,
          ])
          return ok("probed")
        },
      }),
    }
    const twoCalls = {
      toolCalls: [
        { name: "probe", arguments: {} },
        { name: "probe", arguments: {} },
      ],
    }
    const provider = new ScriptedProvider([twoCalls, twoCalls, twoCalls, twoCalls, twoCalls])
    await using(driver, { provider, tools, side: { stopOnResponse: false, maxSteps: 3 } }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({
        status: "idle",
        reason: "max_side_steps",
        steps: 3,
      })
      expect(toolResults(await session.messages(thread))).toHaveLength(6)
    })
    expect(provider.requests).toHaveLength(3)
    expect(probes).toEqual([
      ["a", ["assistant"], 1, 1, 0],
      ["a", ["assistant"], 1, 1, 0],
      ["a", ["assistant"], 2, 2, 0],
      ["a", ["assistant"], 2, 2, 0],
      ["a", ["assistant"], 3, 3, 0],
      ["a", ["assistant"], 3, 3, 0],
    ])
    probes.length = 0
    const reversed = new ScriptedProvider([twoCalls, twoCalls, twoCalls])
    await using(
      driver,
      { provider: reversed, tools, humanOn: "a", side: { stopOnResponse: false, maxSteps: 1 } },
      async (session, thread) => {
        expect(await session.send(thread, "first")).toMatchObject({ reason: "max_side_steps", steps: 1 })
        expect(await session.send(thread, "second")).toMatchObject({ reason: "max_side_steps", steps: 1 })
      },
    )
    expect(reversed.requests).toHaveLength(2)
    expect(probes).toEqual([
      ["b", ["assistant"], 1, 0, 1],
      ["b", ["assistant"], 1, 0, 1],
      ["b", ["assistant"], 1, 0, 1],
      ["b", ["assistant"], 1, 0, 1],
    ])
  },
}

export const S20: Scenario = {
  name: "S20 evaluates stopTool, then stopOnResponse, then maxSteps when more than one rule matches",
  requirements: ["d80e4c71", "7b5d1f06", "44e51927", "8d9a5b12", "35afe886"],
  run: async (driver) => {
    const tools = {
      finish: stubTool("Finish", "finished"),
      other: stubTool("Other", "other"),
    }
    const side = { stopTool: "finish", maxSteps: 1 }
    const toolStop = new ScriptedProvider([{ text: "wrapping up", toolCalls: [{ name: "finish", arguments: {} }] }])
    expect(await runTurn(driver, { provider: toolStop, tools, side }, "go")).toMatchObject({
      reason: "stop_tool",
      steps: 1,
    })
    const responseStop = new ScriptedProvider([{ text: "just text" }])
    expect(await runTurn(driver, { provider: responseStop, tools, side }, "go")).toMatchObject({
      reason: "stop_on_response",
      steps: 1,
    })
    const limit = new ScriptedProvider([{ text: "", toolCalls: [{ name: "other", arguments: {} }] }])
    expect(await runTurn(driver, { provider: limit, tools, side }, "go")).toMatchObject({
      reason: "max_side_steps",
      steps: 1,
    })
  },
}
