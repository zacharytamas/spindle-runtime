import { defineHook, definePrompt, defineTool, type Message, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { callsOf, history, ok, type Scenario, sideOf, statusOf, stubTool } from "../harness.ts"
import { executionSnapshot, handlerOf, sendWith, settledWith, usingHandler } from "./fixtures.ts"

export const HD01: Scenario = {
  name: "HD01 (rules 1, 2, 4, 5, 19, 20, 22, 32) delivers full persisted Messages on handler x human and human x handler with zero steps, empty promptPath, and no auto-reply",
  requirements: ["0747a620", "6ce44191", "ea88514a", "3df00a7e", "b8f7cd7e", "16911055", "ec8cd3e4", "409ce981"],
  run: async (driver) => {
    for (const handlerSide of ["a", "b"] as const) {
      const expectedInboundRole = handlerSide === "a" ? "user" : "assistant"
      const ownRole = handlerSide === "a" ? "assistant" : "user"
      const received: Array<{
        readonly message: Message
        readonly fetched: Message | null
        readonly execution: ReturnType<typeof executionSnapshot>
      }> = []
      const stampHook = defineHook({
        hook: "before_create_message",
        id: "stamp_inbound",
        execute: async (_state, message) => ({
          ...message,
          metadata: { ...message.metadata, stamped: true },
        }),
      })
      const relay_pipe = handlerOf(async (state: ThreadState, message: Message) => {
        const fetched = await state.getMessage(message.id)
        received.push({
          message: structuredClone(message),
          fetched,
          execution: executionSnapshot(state),
        })
        if (message.content === "please reply") {
          await state.injectMessage({ role: ownRole, content: `reply from ${handlerSide}` })
        }
      })
      const sideA = handlerSide === "a" ? ({ handler: "relay_pipe" } as const) : ({ human: true } as const)
      const sideB = handlerSide === "b" ? ({ handler: "relay_pipe" } as const) : ({ human: true } as const)
      await usingHandler(
        driver,
        {
          sideA,
          sideB,
          handlers: { relay_pipe },
          hooks: [stampHook],
          agent: { hooks: ["stamp_inbound"] },
        },
        async (session, thread) => {
          // Plain inbound message: handler does nothing -> no auto-reply message is created.
          const first = await sendWith(session, thread, "hello handler")
          expect(first).toMatchObject({
            status: "idle",
            reason: "handler_idle",
            steps: 0,
            modelCalls: [],
          })
          expect(await statusOf(session, thread)).toMatchObject({ state: "idle", reason: "handler_idle" })
          const afterFirst = await session.messages(thread)
          expect(afterFirst).toHaveLength(1)
          const firstStored = afterFirst[0]
          expect(firstStored).toMatchObject({
            role: expectedInboundRole,
            content: "hello handler",
            status: "completed",
            silent: false,
            prompt: null,
            metadata: { stamped: true },
          })
          expect(first.handlerCalls).toMatchObject([
            { side: handlerSide, handler: "relay_pipe", messageId: firstStored?.id, status: "success" },
          ])

          // Silent queued message with metadata arrives with full persisted Message shape.
          const rest = await session.state(thread)
          await rest.queueMessage({
            role: expectedInboundRole,
            content: "quiet note",
            silent: true,
            metadata: { tag: "audit" },
          })
          const second = await settledWith(session, thread)
          expect(second).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0, modelCalls: [] })

          // Explicit own-role reply via injectMessage persists reply and settles handler_idle (opposite is human).
          const third = await sendWith(session, thread, "please reply")
          expect(third).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0, modelCalls: [] })

          const stored = await session.messages(thread)
          expect(stored.map((m) => [m.role, m.content, m.silent, m.metadata])).toEqual([
            [expectedInboundRole, "hello handler", false, { stamped: true }],
            [expectedInboundRole, "quiet note", true, { tag: "audit", stamped: true }],
            [expectedInboundRole, "please reply", false, { stamped: true }],
            [ownRole, `reply from ${handlerSide}`, false, { stamped: true }],
          ])
          expect(received).toHaveLength(3)
          for (const [index, entry] of received.entries()) {
            expect(entry.message).toEqual(stored[index])
            expect(entry.fetched).toEqual(stored[index])
            expect(entry.execution).toMatchObject({
              currentSide: handlerSide,
              promptPath: [],
              stepCount: 0,
              sideAStepCount: 0,
              sideBStepCount: 0,
            })
            expect(typeof entry.execution?.flowId).toBe("string")
          }
        },
      )
    }
  },
}

export const HD02: Scenario = {
  name: "HD02 (rules 1, 2, 4, 5, 21, 22, 32) runs prompt x handler and handler x prompt delivering every prompt-role message including tool_calls and excluding role: tool",
  requirements: ["0747a620", "3df00a7e", "b8f7cd7e", "16911055", "ec8cd3e4", "2178d58c"],
  run: async (driver) => {
    // Part 1: prompt (side A) x handler (side B).
    const seenB: Array<{
      readonly role: string
      readonly content: string | null
      readonly callIds: ReadonlyArray<string>
      readonly execution: ReturnType<typeof executionSnapshot>
    }> = []
    const side_b_handler = handlerOf(async (state, message) => {
      seenB.push({
        role: message.role,
        content: message.content,
        callIds: callsOf(message).map((c) => c.id),
        execution: executionSnapshot(state),
      })
      // Respond only on the final message of A's first turn, injecting TWO messages (rule 22).
      if (message.content === "A final 1") {
        await state.injectMessage({ role: "user", content: "B follow-up 1" })
        await state.injectMessage({ role: "user", content: "B follow-up 2" })
      }
    })
    const providerA = new ScriptedProvider([
      { toolCalls: [{ id: "tc_only", name: "lookup", arguments: {} }] },
      { text: "A checking", toolCalls: [{ id: "tc_text", name: "lookup", arguments: {} }] },
      { text: "A final 1" },
      { text: "A wrap-up" },
    ])
    await usingHandler(
      driver,
      {
        sideA: { prompt: "worker" },
        sideB: { handler: "side_b_handler" },
        provider: providerA,
        prompts: [
          definePrompt({
            name: "worker",
            toolDescription: "Prompt side A",
            model: "scripted",
            prompt: "You are side A.",
            includeChat: true,
            includePastTools: true,
            tools: ["lookup"],
          }),
        ],
        tools: { lookup: stubTool("Look up value", "found-item") },
        handlers: { side_b_handler },
      },
      async (session, thread) => {
        const outcome = await sendWith(session, thread, "go")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 4 })
        expect(seenB.map((entry) => [entry.role, entry.content, entry.callIds])).toEqual([
          ["assistant", null, ["tc_only"]],
          ["assistant", "A checking", ["tc_text"]],
          ["assistant", "A final 1", []],
          ["assistant", "A wrap-up", []],
        ])
        // Handler turns contribute zero steps; sideAStepCount reflects A's completed model steps.
        expect(seenB.map((entry) => entry.execution)).toEqual([
          expect.objectContaining({
            currentSide: "b",
            promptPath: [],
            stepCount: 3,
            sideAStepCount: 3,
            sideBStepCount: 0,
          }),
          expect.objectContaining({
            currentSide: "b",
            promptPath: [],
            stepCount: 3,
            sideAStepCount: 3,
            sideBStepCount: 0,
          }),
          expect.objectContaining({
            currentSide: "b",
            promptPath: [],
            stepCount: 3,
            sideAStepCount: 3,
            sideBStepCount: 0,
          }),
          expect.objectContaining({
            currentSide: "b",
            promptPath: [],
            stepCount: 4,
            sideAStepCount: 4,
            sideBStepCount: 0,
          }),
        ])
        // One prompt turn on A sees both messages that handler B injected.
        expect(history(providerA.requests[3]).map(sideOf).slice(-3)).toEqual([
          ["assistant", "A final 1", []],
          ["user", "B follow-up 1"],
          ["user", "B follow-up 2"],
        ])
        const stored = await session.messages(thread)
        const deliveredIds = stored.filter((m) => m.role === "assistant").map((m) => m.id)
        expect(outcome.handlerCalls).toMatchObject(
          deliveredIds.map((messageId) => ({
            side: "b",
            handler: "side_b_handler",
            messageId,
            status: "success",
          })),
        )
      },
    )

    // Part 2: handler (side A) x prompt (side B).
    const seenA: Array<{
      readonly role: string
      readonly content: string | null
      readonly callIds: ReadonlyArray<string>
      readonly execution: ReturnType<typeof executionSnapshot>
    }> = []
    const side_a_handler = handlerOf(async (state, message) => {
      seenA.push({
        role: message.role,
        content: message.content,
        callIds: callsOf(message).map((c) => c.id),
        execution: executionSnapshot(state),
      })
      if (message.content === "start") {
        await state.injectMessage({ role: "assistant", content: "A to B" })
      }
    })
    const providerB = new ScriptedProvider([
      { toolCalls: [{ id: "b_tc", name: "check", arguments: {} }] },
      { text: "B reply" },
    ])
    const check = defineTool({
      description: "Check item",
      execute: async () => ok("checked"),
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "side_a_handler" },
        sideB: { prompt: "reviewer" },
        provider: providerB,
        prompts: [
          definePrompt({
            name: "reviewer",
            toolDescription: "Prompt side B",
            model: "scripted",
            prompt: "You are side B.",
            includeChat: true,
            tools: ["check"],
          }),
        ],
        tools: { check },
        handlers: { side_a_handler },
      },
      async (session, thread) => {
        // Rule 32: no human side -> send uses role "user" targeting side A.
        const outcome = await sendWith(session, thread, "start")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 2 })
        expect(seenA.map((entry) => [entry.role, entry.content, entry.callIds])).toEqual([
          ["user", "start", []],
          ["user", null, ["b_tc"]],
          ["user", "B reply", []],
        ])
        expect(seenA.map((entry) => entry.execution)).toEqual([
          expect.objectContaining({
            currentSide: "a",
            promptPath: [],
            stepCount: 0,
            sideAStepCount: 0,
            sideBStepCount: 0,
          }),
          expect.objectContaining({
            currentSide: "a",
            promptPath: [],
            stepCount: 2,
            sideAStepCount: 0,
            sideBStepCount: 2,
          }),
          expect.objectContaining({
            currentSide: "a",
            promptPath: [],
            stepCount: 2,
            sideAStepCount: 0,
            sideBStepCount: 2,
          }),
        ])
        expect(history(providerB.requests[0]).map(sideOf)).toEqual([
          ["assistant", "start", []],
          ["user", "A to B"],
        ])
      },
    )
  },
}

export const HD03: Scenario = {
  name: "HD03 (rules 1, 2, 19, 22, 23, 32) runs handler x handler ping-pong with serialized multi-message handoff and zero model calls",
  requirements: ["0747a620", "ab2038a6", "3df00a7e", "b8f7cd7e", "409ce981", "2178d58c"],
  run: async (driver) => {
    const trace: Array<string> = []
    let active = 0
    let overlapped = false
    const handler_a = handlerOf(async (state, message) => {
      active += 1
      if (active > 1) overlapped = true
      trace.push(`enter:a:${message.content}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (message.content === "kickoff") {
        await state.injectMessage({ role: "assistant", content: "A-1" })
        await state.injectMessage({ role: "assistant", content: "A-2" })
      }
      trace.push(`exit:a:${message.content}`)
      active -= 1
    })
    const handler_b = handlerOf(async (state, message) => {
      active += 1
      if (active > 1) overlapped = true
      trace.push(`enter:b:${message.content}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      // Ignore A-1 (rule 23: continues to A-2), reply on A-2.
      if (message.content === "A-2") {
        await state.injectMessage({ role: "user", content: "B-reply" })
      }
      trace.push(`exit:b:${message.content}`)
      active -= 1
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "handler_a" },
        sideB: { handler: "handler_b" },
        handlers: { handler_a, handler_b },
      },
      async (session, thread) => {
        const outcome = await sendWith(session, thread, "kickoff")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0, modelCalls: [] })
        expect(overlapped).toBe(false)
        expect(trace).toEqual([
          "enter:a:kickoff",
          "exit:a:kickoff",
          "enter:b:A-1",
          "exit:b:A-1",
          "enter:b:A-2",
          "exit:b:A-2",
          "enter:a:B-reply",
          "exit:a:B-reply",
        ])
        const stored = await session.messages(thread)
        expect(stored.map((m) => [m.role, m.content])).toEqual([
          ["user", "kickoff"],
          ["assistant", "A-1"],
          ["assistant", "A-2"],
          ["user", "B-reply"],
        ])
        expect(outcome.handlerCalls).toMatchObject([
          { side: "a", handler: "handler_a", messageId: stored[0]?.id, status: "success" },
          { side: "b", handler: "handler_b", messageId: stored[1]?.id, status: "success" },
          { side: "b", handler: "handler_b", messageId: stored[2]?.id, status: "success" },
          { side: "a", handler: "handler_a", messageId: stored[3]?.id, status: "success" },
        ])
      },
    )
  },
}
