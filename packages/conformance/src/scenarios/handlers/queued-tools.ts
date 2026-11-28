import { defineHook, definePrompt, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { callsOf, history, ok, type Scenario, sideOf, statusOf, toolResults } from "../harness.ts"
import { dualProject } from "../sides/fixtures.ts"
import { executionSnapshot, handlerOf, sendWith, settledWith, usingHandler } from "./fixtures.ts"

export const HD13: Scenario = {
  name: "HD13 (rules 27, 28, 29, 30) runs handler-owned queued tools with prompt: null, agent hooks, agent env, no handler invocation, and handler_idle",
  requirements: ["409ce981", "b8f7cd7e", "1a0354bc"],
  run: async (driver) => {
    // Part 1: handler x human (side A) and human x handler (side B) queued at rest (side: null).
    for (const handlerSide of ["a", "b"] as const) {
      const expectedRole = handlerSide === "a" ? "assistant" : "user"
      let handlerCalls = 0
      const hookOrder: Array<string> = []
      const toolSnapshots: Array<ReturnType<typeof executionSnapshot>> = []
      const hooks = [
        defineHook({
          hook: "tool_call_started",
          id: "t_started",
          execute: async () => {
            hookOrder.push("started")
          },
        }),
        defineHook({
          hook: "after_tool_call_success",
          id: "t_success",
          execute: async (_state, _call, result) => {
            hookOrder.push("success")
            return result
          },
        }),
        defineHook({
          hook: "after_tool_call_failure",
          id: "t_failure",
          execute: async (_state, _call, result) => {
            hookOrder.push("failure")
            return result
          },
        }),
        defineHook({
          hook: "before_store_tool_result",
          id: "t_before_store",
          execute: async (_state, _call, result) => {
            hookOrder.push("before_store")
            return result
          },
        }),
        defineHook({
          hook: "tool_call_done",
          id: "t_done",
          execute: async () => {
            hookOrder.push("done")
          },
        }),
      ]
      const tools = {
        read_agent_env: defineTool({
          description: "Reads agent env and optionally fails",
          args: z.object({ fail: z.boolean().optional() }),
          execute: async (state: ThreadState, args: { fail?: boolean | undefined }) => {
            toolSnapshots.push(executionSnapshot(state))
            if (args.fail) return { status: "error" as const, error: "expected tool failure" }
            const value = await state.env("HANDLER_AGENT_ENV")
            expect(value).toBe(`side-${handlerSide}`)
            return ok(`val=${value}`)
          },
        }),
      }
      const noop_handler = handlerOf(async () => {
        handlerCalls += 1
      })
      const sideA = handlerSide === "a" ? ({ handler: "noop_handler" } as const) : ({ human: true } as const)
      const sideB = handlerSide === "b" ? ({ handler: "noop_handler" } as const) : ({ human: true } as const)
      await usingHandler(
        driver,
        {
          sideA,
          sideB,
          handlers: { noop_handler },
          tools,
          hooks,
          agent: {
            env: { HANDLER_AGENT_ENV: `side-${handlerSide}` },
            hooks: ["t_started", "t_success", "t_failure", "t_before_store", "t_done"],
          },
        },
        async (session, thread) => {
          const rest = await session.state(thread)
          rest.queueTool("read_agent_env", {})
          const out1 = await settledWith(session, thread)
          expect(await statusOf(session, thread)).toMatchObject({ state: "idle", reason: "handler_idle" })
          if (out1 !== undefined) {
            expect(out1).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0, modelCalls: [] })
          }

          rest.queueTool("read_agent_env", { fail: true })
          const out2 = await settledWith(session, thread)
          expect(await statusOf(session, thread)).toMatchObject({ state: "idle", reason: "handler_idle" })
          if (out2 !== undefined) {
            expect(out2).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0, modelCalls: [] })
          }

          expect(handlerCalls).toBe(0)
          expect(hookOrder).toEqual([
            "started",
            "success",
            "before_store",
            "done",
            "started",
            "failure",
            "before_store",
            "done",
          ])
          expect(toolSnapshots).toEqual([
            expect.objectContaining({ currentSide: handlerSide, promptPath: [], stepCount: 0 }),
            expect.objectContaining({ currentSide: handlerSide, promptPath: [], stepCount: 0 }),
          ])

          const stored = await session.messages(thread)
          expect(stored.map((m) => [m.role, m.content, m.prompt, m.tool_status, m.metadata])).toEqual([
            [expectedRole, null, null, null, { queued: true }],
            ["tool", "val=[redacted]", null, "success", {}],
            [expectedRole, null, null, null, { queued: true }],
            ["tool", "expected tool failure", null, "error", {}],
          ])
          expect(callsOf(stored[0])[0]?.id).toMatch(/^queued-/)
          const inspected = await session.inspect(thread)
          expect(toolResults(inspected.messages).map((m) => m.callerSeq)).toEqual([
            inspected.messages[0]?.seq,
            inspected.messages[2]?.seq,
          ])
        },
      )
    }

    // Part 2: on handler (side A) x prompt (side B):
    // - queueTool called from handler A records side: "a" -> owned by handler A (prompt: null, no prompt B call!)
    // - queueTool called at rest records side: null -> rule 28 picks the single prompt side B (prompt: "reviewer", prompt B runs!)
    const deliveredIds: Array<string> = []
    const handler_a = handlerOf(async (state, message) => {
      deliveredIds.push(message.id)
      if (message.content === "queue-from-handler") {
        state.queueTool("ping_tool", { source: "handler-a" })
      }
    })
    const providerB = new ScriptedProvider([{ text: "B saw rest queued tool" }])
    const ping_tool = defineTool({
      description: "Echo source",
      args: z.object({ source: z.string() }),
      execute: async (_state: ThreadState, args: { source: string }) => ok(`ran:${args.source}`),
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "handler_a" },
        sideB: { prompt: "reviewer" },
        provider: providerB,
        prompts: [
          definePrompt({
            name: "reviewer",
            toolDescription: "Prompt B",
            model: "scripted",
            prompt: "You are B.",
            includeChat: true,
            includePastTools: true,
            tools: ["ping_tool"],
          }),
        ],
        tools: { ping_tool },
        handlers: { handler_a },
      },
      async (session, thread) => {
        // Handler A queues tool during its turn -> owned by side A (handler), prompt B never runs, handler A doesn't re-run.
        const outHandler = await sendWith(session, thread, "queue-from-handler")
        expect(outHandler).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0, modelCalls: [] })
        expect(deliveredIds).toHaveLength(1)
        expect(providerB.requests).toHaveLength(0)
        const afterHandlerTool = await session.messages(thread)
        expect(afterHandlerTool.map((m) => [m.role, m.content, m.prompt])).toEqual([
          ["user", "queue-from-handler", null],
          ["assistant", null, null],
          ["tool", "ran:handler-a", null],
        ])

        // At rest (side: null) -> rule 28 picks prompt side B, which stores role: "user", prompt: "reviewer" and runs a model step.
        const rest = await session.state(thread)
        rest.queueTool("ping_tool", { source: "at-rest" })
        const outRest = await settledWith(session, thread)
        expect(await statusOf(session, thread)).toMatchObject({ state: "idle", reason: "handler_idle" })
        if (outRest !== undefined) {
          expect(outRest).toMatchObject({ status: "idle", reason: "handler_idle", steps: 1 })
        }
        expect(providerB.requests).toHaveLength(1)
        const all = await session.messages(thread)
        expect(all.slice(3).map((m) => [m.role, m.content, m.prompt])).toEqual([
          ["user", null, null],
          ["tool", "ran:at-rest", "reviewer"],
          ["user", "B saw rest queued tool", "reviewer"],
        ])
        // Rule 21 includes the synthetic caller and the model reply from B.
        expect(deliveredIds).toEqual([all[0]?.id, all[3]?.id, all[5]?.id])
      },
    )
  },
}

export const HD14: Scenario = {
  name: "HD14 (rules 27, 28, 29, 30, 31) attributes queued tools on handler x handler and prompt x prompt by side and pauses prompt drain at opposite handler entries",
  requirements: ["409ce981", "b8f7cd7e"],
  run: async (driver) => {
    const tag_tool = defineTool({
      description: "Record which side ran the queued tool",
      args: z.object({ tag: z.string() }),
      execute: async (state: ThreadState, args: { tag: string }) =>
        ok(`${args.tag}:side=${state.execution?.currentSide}`),
    })

    // Part 1: handler x handler — at rest (side: null -> side A), from side B handler (side: "b" -> side B).
    let runsA = 0
    let runsB = 0
    const h_a = handlerOf(async (state, message) => {
      runsA += 1
      if (message.content === "trigger-b") await state.injectMessage({ role: "assistant", content: "to-b" })
    })
    const h_b = handlerOf(async (state) => {
      runsB += 1
      state.queueTool("tag_tool", { tag: "from-b" })
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "h_a" },
        sideB: { handler: "h_b" },
        handlers: { h_a, h_b },
        tools: { tag_tool },
      },
      async (session, thread) => {
        // At rest on handler x handler -> side A ("assistant", prompt: null).
        const rest = await session.state(thread)
        rest.queueTool("tag_tool", { tag: "rest" })
        const outRest = await settledWith(session, thread)
        expect(await statusOf(session, thread)).toMatchObject({ state: "idle", reason: "handler_idle" })
        if (outRest !== undefined) {
          expect(outRest).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
        }
        expect([runsA, runsB]).toEqual([0, 0])

        // Trigger side B handler, which calls queueTool -> side B ("user", prompt: null).
        expect(await sendWith(session, thread, "trigger-b")).toMatchObject({
          status: "idle",
          reason: "handler_idle",
          steps: 0,
        })
        expect([runsA, runsB]).toEqual([1, 1])
        expect((await session.messages(thread)).map((m) => [m.role, m.content, m.prompt])).toEqual([
          ["assistant", null, null],
          ["tool", "rest:side=a", null],
          ["user", "trigger-b", null],
          ["assistant", "to-b", null],
          ["user", null, null],
          ["tool", "from-b:side=b", null],
        ])
      },
    )

    // Part 2: prompt x prompt — queued tool from side B records side: "b" and runs on side B (role: "user", prompt: "reviewer").
    const queue_b_tool = defineTool({
      description: "Queue tag_tool from side B",
      execute: async (state: ThreadState) => {
        state.queueTool("tag_tool", { tag: "b-queued" })
        return ok("queued-on-b")
      },
    })
    const providerA = new ScriptedProvider([{ text: "A1" }])
    const providerB = new ScriptedProvider([
      { toolCalls: [{ id: "qb1", name: "queue_b_tool", arguments: {} }] },
      { text: "B saw its own queued tool" },
    ])
    const dualSession = await driver.load(
      dualProject({
        providerA,
        providerB,
        tools: { queue_b_tool, tag_tool },
        promptA: { includeChat: true, tools: [] },
        promptB: { includeChat: true, includePastTools: true, tools: ["queue_b_tool", "tag_tool"] },
        agent: { maxSessionTurns: 2 },
      }),
    )
    try {
      const thread = await dualSession.createThread("pair")
      expect(await dualSession.send(thread, "go")).toMatchObject({
        status: "idle",
        reason: "max_session_turns",
        steps: 3,
      })
      const stored = await dualSession.messages(thread)
      expect(stored.map((m) => [m.role, m.content, m.prompt])).toEqual([
        ["user", "go", null],
        ["assistant", "A1", "worker"],
        ["user", null, "reviewer"],
        ["tool", "queued-on-b", "reviewer"],
        ["user", null, null],
        ["tool", "b-queued:side=b", "reviewer"],
        ["user", "B saw its own queued tool", "reviewer"],
      ])
    } finally {
      await dualSession.close()
    }

    // Part 3 (rule 31): prompt side A pauses draining at a queue head targeting opposite handler side B
    // (both a message for B and a queued tool owned by B).
    const seenB: Array<string | null> = []
    const recv_b = handlerOf(async (state, message) => {
      seenB.push(message.content)
      if (message.content === "for-B-handler") {
        state.queueTool("tag_tool", { tag: "owned-by-b" })
        await state.injectMessage({ role: "user", content: "reply-from-B" })
      }
    })
    const queue_mixed = defineTool({
      description: "Queue A message, B message, then A message",
      execute: async (state: ThreadState) => {
        await state.queueMessage({ role: "user", content: "for-A" })
        await state.queueMessage({ role: "assistant", content: "for-B-handler" })
        await state.queueMessage({ role: "user", content: "after-B-handler" })
        return ok("queued")
      },
    })
    const mixedA = new ScriptedProvider([
      { toolCalls: [{ id: "qm", name: "queue_mixed", arguments: {} }] },
      { text: "A-turn-1" },
      { text: "A-turn-2" },
    ])
    await usingHandler(
      driver,
      {
        sideA: { prompt: "worker" },
        sideB: { handler: "recv_b" },
        provider: mixedA,
        prompts: [
          definePrompt({
            name: "worker",
            toolDescription: "Prompt A",
            model: "scripted",
            prompt: "You are A.",
            includeChat: true,
            tools: ["queue_mixed"],
          }),
        ],
        tools: { queue_mixed, tag_tool },
        handlers: { recv_b },
      },
      async (session, thread) => {
        const outcome = await sendWith(session, thread, "go")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 3 })
        // A's step 2 drained "for-A" and paused before "for-B-handler" and "after-B-handler".
        expect(history(mixedA.requests[1]).map(sideOf)).toEqual([
          ["user", "go"],
          ["assistant", null, ["qm"]],
          ["tool", "qm"],
          ["user", "for-A"],
        ])
        // A's turn 2 saw "reply-from-B" and paused before B's queued tool "owned-by-b" (so it did NOT drain it).
        expect(JSON.stringify(mixedA.requests[2])).not.toContain("owned-by-b")
        // Handler B received A's turn-1 messages first (rule 21), then "for-B-handler" (which queued owned-by-b
        // and handed off to A), then A's "A-turn-2", and then B drained its queued tool "owned-by-b" with prompt: null.
        expect(seenB).toEqual([null, "A-turn-1", "for-B-handler", "A-turn-2"])
        const bToolResult = (await session.messages(thread)).find(
          (m) => m.role === "tool" && m.content === "owned-by-b:side=b",
        )
        expect(bToolResult).toMatchObject({ role: "tool", prompt: null, tool_status: "success" })
      },
    )
  },
}
