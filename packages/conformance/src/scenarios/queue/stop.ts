import { defineHook, defineTool, type ExecutionState, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { callsOf, firstToolResult, gate, history, ok, type Scenario, SIDES, toolResults, using } from "../harness.ts"

import { noop } from "./fixtures.ts"

const stopOnStart = defineHook({
  hook: "tool_call_started",
  id: "stop_on_start",
  execute: async (state) => {
    state.execution?.stop()
  },
})

export const Q11: Scenario = {
  name: "Q11 lets the model call in flight finish when stop is called, then runs no tool and no step and settles idle",
  requirements: ["7a032a6c", "7a728ef6", "da3295e2", "37e4432c"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      let execution: ExecutionState | null = null
      const ran: Array<string> = []
      const held = gate()
      const release = gate()
      const keep = defineHook({
        hook: "tool_call_started",
        id: "keep",
        execute: async (state) => {
          execution = state.execution
          held.release()
          await release.opened
        },
      })
      const provider = new ScriptedProvider([
        { text: "partial", toolCalls: [{ id: "c_noop", name: "noop", arguments: {} }] },
        { text: "next" },
      ])
      const tracked = defineTool({
        description: "Do nothing",
        execute: async () => {
          ran.push("noop")
          return ok("noop")
        },
      })
      await using(
        driver,
        { provider, humanOn, tools: { noop: tracked }, hooks: [keep], prompt: { hooks: ["keep"] } },
        async (session, thread) => {
          const run = session.send(thread, "go")
          await held.opened
          const active = execution as ExecutionState | null
          expect(active?.stopped).toBe(false)
          expect(active?.stop()).toBeUndefined()
          expect([active?.stopped, active?.stoppedBy, active?.abortSignal.aborted]).toEqual([
            true,
            humanOn === "b" ? "a" : "b",
            false,
          ])
          release.release()
          expect(await run).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
          expect(ran).toEqual([])
          expect(provider.requests).toHaveLength(1)
          const stored = await session.messages(thread)
          expect(stored.map((m) => [m.role === "tool" ? "tool" : m.content, m.tool_status])).toEqual([
            ["go", null],
            ["partial", null],
            ["tool", "error"],
          ])
          const state = await session.state(thread)
          expect([await state.status(), state.terminated]).toEqual([
            { state: "idle", since: expect.any(Number), reason: "aborted" },
            null,
          ])
          expect(await session.send(thread, "again")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        },
      )
    }
  },
}

export const Q12: Scenario = {
  name: "Q12 lets a running tool finish after stop, runs no later call, and starts a send that waited only after it settles",
  requirements: ["7a032a6c", "7a728ef6", "6f984718", "0953e887"],
  run: async (driver) => {
    for (const watching of [true, false]) {
      const held = gate()
      const release = gate()
      let finished = false
      let execution: ExecutionState | null = null
      const observed: Array<unknown> = []
      // The tool exposes its execution, so that the test calls stop while the tool runs. A watching tool also ends
      // when the abort signal fires, and stop does not fire it.
      const hold = defineTool({
        description: "Wait for the test",
        execute: async (state: ThreadState) => {
          execution = state.execution
          const signal = state.execution?.abortSignal
          held.release()
          await (watching
            ? Promise.race([release.opened, new Promise((resolve) => signal?.addEventListener("abort", resolve))])
            : release.opened)
          observed.push({ stopped: state.execution?.stopped, aborted: signal?.aborted })
          finished = true
          return ok("held")
        },
      })
      const ran: Array<string> = []
      const second = defineTool({
        description: "Record that it ran",
        execute: async () => {
          ran.push("second")
          return ok("second")
        },
      })
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c_hold", name: "hold", arguments: {} },
            { id: "c_second", name: "second", arguments: {} },
          ],
        },
        (request) => ({ text: `after the tool: ${finished}, ${history(request).at(-1)?.content}` }),
      ])
      await using(driver, { provider, tools: { hold, second } }, async (session, thread) => {
        const run = session.send(thread, "go")
        await held.opened
        const waiting = session.send(thread, "next")
        ;(execution as ExecutionState | null)?.stop()
        release.release()
        expect(await run).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
        expect(observed).toEqual([{ stopped: true, aborted: false }])
        expect(ran).toEqual([])
        expect(await waiting).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
        expect(provider.requests).toHaveLength(2)
        expect((await session.messages(thread)).map((m) => [m.role, m.tool_status ?? m.content])).toEqual([
          ["user", "go"],
          ["assistant", null],
          ["tool", "success"],
          ["tool", "error"],
          ["user", "next"],
          ["assistant", "after the tool: true, next"],
        ])
      })
    }
  },
}

export const Q18: Scenario = {
  name: "Q18 does not run a queued tool whose started hook or create hook calls stop, and stores one result that says so",
  requirements: ["7a032a6c"],
  run: async (driver) => {
    const started = defineHook({
      hook: "tool_call_started",
      id: "stop_when_started",
      execute: async (state) => {
        state.execution?.stop()
      },
    })
    const beforeCreate = defineHook({
      hook: "before_create_message",
      id: "stop_before_create",
      execute: async (state, message) => {
        if (message.metadata?.queued === true) state.execution?.stop()
        return message
      },
    })
    const afterCreate = defineHook({
      hook: "after_create_message",
      id: "stop_after_create",
      execute: async (state, message) => {
        if (message.metadata?.queued === true) state.execution?.stop()
      },
    })
    const seen: Record<string, unknown> = {}
    for (const hook of [started, beforeCreate, afterCreate]) {
      let entries = 0
      const worker = defineTool({
        description: "Count each run",
        execute: async () => {
          entries += 1
          return ok("the effect happened")
        },
      })
      const provider = new ScriptedProvider([{ text: "a reply that no stopped run asks for" }])
      await using(
        driver,
        { provider, tools: { worker }, hooks: [hook], prompt: { hooks: [hook.id] } },
        async (session, thread) => {
          ;(await session.state(thread)).queueTool("worker", {})
          const outcome = await session.settled(thread)
          const stored = await session.messages(thread)
          const call = callsOf(stored.find((message) => message.metadata?.queued === true))[0]
          const results = toolResults(stored)
          seen[hook.id] = {
            entries,
            outcome: [outcome?.status, outcome?.reason],
            requests: provider.requests.length,
            results: results.map((m) => [
              m.tool_call_id === call?.id,
              m.tool_status,
              /did not run/.test(m.content ?? ""),
            ]),
          }
        },
      )
    }
    const stopped = { entries: 0, outcome: ["idle", "aborted"], requests: 0, results: [[true, "error", true]] }
    expect(seen).toEqual({ stop_when_started: stopped, stop_before_create: stopped, stop_after_create: stopped })
  },
}

export const Q19: Scenario = {
  name: "Q19 does not retry a model attempt that was cut off after stop was called",
  requirements: ["7a032a6c"],
  run: async (driver) => {
    const provider = new ScriptedProvider([
      // Ending without a finish chunk cuts off the attempt after the started hook requests a stop.
      {
        chunks: [
          { type: "tool-call-start", id: "c_noop", name: "noop" },
          { type: "tool-call-done", id: "c_noop", arguments: {} },
        ],
      },
      { text: "from the retry" },
    ])
    await using(
      driver,
      { provider, tools: { noop }, hooks: [stopOnStart], prompt: { hooks: [stopOnStart.id] } },
      async (session, thread) => {
        const outcome = await session.send(thread, "go")
        expect({
          requests: provider.requests.length,
          outcome: [outcome.status, outcome.reason],
          stored: (await session.messages(thread)).map((message) => message.content),
        }).toEqual({ requests: 1, outcome: ["idle", "aborted"], stored: ["go"] })
      },
    )
  },
}

export const Q20: Scenario = {
  name: "Q20 runs a queued tool once when its started hook and its create hooks ask for no stop",
  requirements: [],
  run: async (driver) => {
    let entries = 0
    const calls: Array<string> = []
    const worker = defineTool({
      description: "Count each run",
      execute: async () => {
        entries += 1
        return ok("the effect happened")
      },
    })
    const started = defineHook({
      hook: "tool_call_started",
      id: "watch_started",
      execute: async (_state, call) => {
        calls.push(call.function.name)
      },
    })
    const provider = new ScriptedProvider([{ text: "saw it" }])
    await using(
      driver,
      { provider, tools: { worker }, hooks: [started], prompt: { hooks: ["watch_started"] } },
      async (session, thread) => {
        ;(await session.state(thread)).queueTool("worker", {})
        expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
        expect([entries, calls]).toEqual([1, ["worker"]])
        expect((await session.messages(thread)).map((m) => m.tool_status ?? m.content)).toEqual([
          null,
          "success",
          "saw it",
        ])
      },
    )
  },
}

export const Q21: Scenario = {
  name: "Q21 keeps the result of a call that a stop left unstarted an error that says it did not run, whatever a hook returns",
  requirements: ["7a032a6c"],
  run: async (driver) => {
    const success = { status: "success" as const, result: "sent successfully" }
    const failureHook = defineHook({
      hook: "after_tool_call_failure",
      id: "relabel_failure",
      execute: async () => success,
    })
    const resultHook = defineHook({
      hook: "before_store_tool_result",
      id: "relabel_result",
      execute: async () => success,
    })
    const createHook = defineHook({
      hook: "before_create_message",
      id: "relabel_message",
      // A create hook may rewrite the text of a message, so this one changes only the status.
      execute: async (_state, message) =>
        message.role === "tool" ? { ...message, tool_status: "success" as const } : message,
    })
    const seen: Record<string, unknown> = {}
    for (const hook of [failureHook, resultHook, createHook]) {
      let entries = 0
      const worker = defineTool({
        description: "Count each run",
        execute: async () => {
          entries += 1
          return ok("the effect happened")
        },
      })
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "x", name: "worker", arguments: {} },
            { id: "y", name: "worker", arguments: {} },
          ],
        },
      ])
      await using(
        driver,
        { provider, tools: { worker }, hooks: [stopOnStart, hook], prompt: { hooks: [stopOnStart.id, hook.id] } },
        async (session, thread) => {
          const outcome = await session.send(thread, "go")
          const results = toolResults(await session.messages(thread))
          seen[hook.id] = {
            entries,
            outcome: [outcome.status, outcome.reason],
            results: results.map((m) => [m.tool_call_id, m.tool_status, /did not run/.test(m.content ?? "")]),
          }
        },
      )
    }
    const kept = {
      entries: 0,
      outcome: ["idle", "aborted"],
      results: [
        ["x", "error", true],
        ["y", "error", true],
      ],
    }
    expect(seen).toEqual({ relabel_failure: kept, relabel_result: kept, relabel_message: kept })
  },
}

export const Q22: Scenario = {
  name: "Q22 still lets a failure hook replace the result of a call that ran and failed",
  requirements: [],
  run: async (driver) => {
    let entries = 0
    const failing = defineTool({
      description: "Run and fail",
      execute: async () => {
        entries += 1
        return { status: "error" as const, error: "the tool failed" }
      },
    })
    const recover = defineHook({
      hook: "after_tool_call_failure",
      id: "recover",
      execute: async () => ({ status: "success" as const, result: "recovered by the hook" }),
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_failing", name: "failing", arguments: {} }] },
      { text: "done" },
    ])
    await using(
      driver,
      { provider, tools: { failing }, hooks: [recover], prompt: { hooks: ["recover"] } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const result = firstToolResult(await session.messages(thread))
        expect([entries, result?.tool_call_id, result?.tool_status, result?.content]).toEqual([
          1,
          "c_failing",
          "success",
          "recovered by the hook",
        ])
      },
    )
  },
}
