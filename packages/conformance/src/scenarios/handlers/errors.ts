import { definePrompt, defineTool, type HandlerDefinition, type Message, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { attempt, gate, holding, ok, quiet, type Scenario, statusOf, stubTool } from "../harness.ts"
import { handlerOf, sendWith, usingHandler, usingHandlerPeer } from "./fixtures.ts"

export const HD08: Scenario = {
  name: "HD08 (rule 26, decision 5, §3) persists inbound message and writes on sync throw, rejection, or throwing thenable, logs redacted runtime error, never redelivers, and settles failed (handler_error) preserving session_turns",
  requirements: ["78f43349", "2c8bc235", "00d791ec", "0d6ca25b", "15c20fb2"],
  run: async (driver) => {
    const secret = "HANDLER-SECRET-9182"
    const modes = ["sync-throw", "async-reject", "throwing-thenable"] as const
    for (const mode of modes) {
      let retained: ThreadState | undefined
      const seen: Array<string | null> = []
      const failing: HandlerDefinition = {
        [Symbol.for("standardagents.handler")]: true,
        description: `Fails via ${mode}`,
        execute: (state: ThreadState, message: Message) => {
          seen.push(message.content)
          retained = state
          if (message.content === "boom") {
            if (mode === "sync-throw") {
              throw new Error(`sync boom ${secret}`)
            }
            if (mode === "throwing-thenable") {
              const thenable: Record<string, unknown> = {}
              Reflect.set(thenable, "then", () => {
                throw new Error(`thenable boom ${secret}`)
              })
              return thenable as unknown as Promise<void>
            }
            return (async () => {
              await state.setValue("committed_before_throw", "kept")
              await state.injectMessage({ role: "assistant", content: "partial before throw" })
              // Learn the instance secret before throwing so redaction covers it.
              await state.instanceEnv?.("HANDLER_SECRET")
              throw new Error(`async boom ${secret}`)
            })()
          }
          return Promise.resolve()
        },
      } as unknown as HandlerDefinition

      const providerB = new ScriptedProvider([{ text: "B should never run after throw" }])
      await usingHandler(
        driver,
        {
          sideA: { handler: "failing" },
          sideB: mode === "async-reject" ? { prompt: "reviewer" } : { human: true },
          ...(mode === "async-reject"
            ? {
                provider: providerB,
                prompts: [
                  definePrompt({
                    name: "reviewer",
                    toolDescription: "Prompt B",
                    model: "scripted",
                    prompt: "You are B.",
                  }),
                ],
              }
            : {}),
          handlers: { failing },
          agent: { maxSessionTurns: 2 },
        },
        async (session, thread) => {
          const failed = await sendWith(session, thread, "boom")
          expect(failed).toMatchObject({ status: "failed", reason: "handler_error", steps: 0, modelCalls: [] })
          expect(await statusOf(session, thread)).toMatchObject({ state: "failed", reason: "handler_error" })
          expect((await session.inspect(thread)).terminated).toBeNull()

          // Inbound message and committed writes stay persisted; throwing turn does NOT hand off to prompt B.
          const afterBoom = await session.messages(thread)
          expect(afterBoom[0]).toMatchObject({ role: "user", content: "boom" })
          if (mode === "async-reject") {
            expect(afterBoom.map((m) => [m.role, m.content])).toEqual([
              ["user", "boom"],
              ["assistant", "partial before throw"],
            ])
            expect(await (await session.state(thread)).getValue("committed_before_throw")).toBe("kept")
            expect(providerB.requests).toHaveLength(0)
          }

          // Runtime-origin failure recorded on RunOutcome.handlerCalls and logged redacted.
          expect(failed.handlerCalls).toMatchObject([
            {
              side: "a",
              handler: "failing",
              messageId: afterBoom[0]?.id,
              status: "failed",
              error: { origin: "runtime", message: expect.stringContaining("boom") },
            },
          ])
          if (mode === "async-reject") {
            expect(holding(failed, secret)).toEqual([])
            expect(holding(session.logs(), secret)).toEqual([])
          }
          expect(session.logs().some((line) => line.includes("failing") || line.includes("boom"))).toBe(true)

          // Handle from the failed turn is expired.
          expect(await attempt(() => retained?.setValue("late", "no"))).toBe("HandleExpired")

          // Next message gets a fresh invocation without redelivering "boom"; session_turns was preserved at 1,
          // so this 2nd turn hits maxSessionTurns: 2!
          const next = await sendWith(session, thread, "after-error")
          expect(next).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 0 })
          expect(seen).toEqual(["boom", "after-error"])
        },
        { instanceEnv: { HANDLER_SECRET: secret } },
      )
    }
  },
}

export const HD09: Scenario = {
  name: "HD09 (rules 23, 26, decision 5) continues delivering peer's remaining messages then queued entries after a handler throw, settling handler_error only if the last delivery threw",
  requirements: ["0747a620", "78f43349", "2c8bc235", "00d791ec", "0d6ca25b", "15c20fb2"],
  run: async (driver) => {
    // Part 1: Prompt persists M1 (with tool_calls) and M2; tool also queues "queued-for-B".
    // Handler B throws on M1, succeeds on M2, succeeds on "queued-for-B" -> receives all 3 in order
    // (peer's remaining message M2 BEFORE queued entry!), settles idle (handler_idle) because last succeeded.
    const seen1: Array<string | null> = []
    const queue_for_b = defineTool({
      description: "Queue message for side B",
      execute: async (state: ThreadState) => {
        await state.queueMessage({ role: "assistant", content: "queued-for-B" })
        return ok("queued")
      },
    })
    const throw_first_b = handlerOf(async (_state, message) => {
      seen1.push(message.content)
      if (message.content === "M1") throw new Error("M1 failed")
    })
    const provider1 = new ScriptedProvider([
      { text: "M1", toolCalls: [{ id: "q1", name: "queue_for_b", arguments: {} }] },
      { text: "M2" },
    ])
    await usingHandler(
      driver,
      {
        sideA: { prompt: "worker" },
        sideB: { handler: "throw_first_b" },
        provider: provider1,
        prompts: [
          definePrompt({
            name: "worker",
            toolDescription: "Prompt A",
            model: "scripted",
            prompt: "You are A.",
            tools: ["queue_for_b"],
          }),
        ],
        tools: { queue_for_b },
        handlers: { throw_first_b },
      },
      async (session, thread) => {
        const outcome = await sendWith(session, thread, "go")
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 2 })
        expect(seen1).toEqual(["M1", "M2", "queued-for-B"])
        const stored = await session.messages(thread)
        const assistantIds = stored.filter((m) => m.role === "assistant").map((m) => m.id)
        expect(outcome.handlerCalls).toMatchObject([
          {
            side: "b",
            handler: "throw_first_b",
            messageId: assistantIds[0],
            status: "failed",
            error: { origin: "runtime", message: expect.stringContaining("M1 failed") },
          },
          { side: "b", handler: "throw_first_b", messageId: assistantIds[1], status: "success" },
          { side: "b", handler: "throw_first_b", messageId: assistantIds[2], status: "success" },
        ])
      },
    )

    // Part 2: Prompt persists M1 and M2; handler B throws on BOTH M1 and M2 -> still receives M2,
    // settles failed (handler_error) with session_turns preserved (decision 5).
    const seen2: Array<string | null> = []
    const throw_both_b = handlerOf(async (_state, message) => {
      seen2.push(message.content)
      if (message.content === "M1" || message.content === "M2") throw new Error(`failed:${message.content}`)
    })
    const provider2 = new ScriptedProvider([
      { text: "M1", toolCalls: [{ id: "t1", name: "noop", arguments: {} }] },
      { text: "M2" },
      { text: "M3" },
    ])
    await usingHandler(
      driver,
      {
        sideA: { prompt: "worker" },
        sideB: { handler: "throw_both_b" },
        provider: provider2,
        prompts: [
          definePrompt({
            name: "worker",
            toolDescription: "Prompt A",
            model: "scripted",
            prompt: "You are A.",
            tools: ["noop"],
          }),
        ],
        tools: { noop: stubTool("No-op", "ok") },
        handlers: { throw_both_b },
        agent: { maxSessionTurns: 4 },
      },
      async (session, thread) => {
        // Turn 1: prompt A (session_turns = 1). Turn 2: handler B M1 throws (session_turns = 2).
        // Turn 3: handler B M2 throws (session_turns = 3) -> settles failed (handler_error), preserving session_turns = 3.
        const first = await sendWith(session, thread, "go")
        expect(first).toMatchObject({ status: "failed", reason: "handler_error", steps: 2 })
        expect(seen2).toEqual(["M1", "M2"])
        expect(first.handlerCalls).toMatchObject([
          { side: "b", handler: "throw_both_b", status: "failed", error: { origin: "runtime" } },
          { side: "b", handler: "throw_both_b", status: "failed", error: { origin: "runtime" } },
        ])
        // Next send: prompt A takes turn 4 -> hits maxSessionTurns: 4 (proving session_turns = 3 was preserved!).
        const second = await sendWith(session, thread, "continue")
        expect(second).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 1 })
        expect(seen2).toEqual(["M1", "M2"])
      },
    )

    // Part 3: Throwing on queued message 1 while queued message 2 is pending delivers message 2 next.
    const enteredQ1 = gate()
    const releaseQ1 = gate()
    const seenQ: Array<string | null> = []
    const throw_q1 = handlerOf(async (_state, message) => {
      seenQ.push(message.content)
      if (message.content === "q1") {
        enteredQ1.release()
        await releaseQ1.opened
        throw new Error("q1 exploded")
      }
    })
    await usingHandlerPeer(
      driver,
      {
        sideA: { handler: "throw_q1" },
        sideB: { human: true },
        handlers: { throw_q1 },
      },
      async (session, thread, peer) => {
        const run = quiet(sendWith(session, thread, "q1"))
        try {
          await Promise.race([
            enteredQ1.opened,
            quiet(
              run.then((outcome) => {
                throw new Error(`run settled before entering q1 handler: ${outcome.status} (${outcome.reason})`)
              }),
            ),
          ])
          await (await peer.state(thread)).queueMessage({ role: "user", content: "q2" })
        } finally {
          releaseQ1.release()
        }
        const outcome = await run
        expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
        expect(seenQ).toEqual(["q1", "q2"])
        expect(outcome.handlerCalls).toMatchObject([
          { side: "a", handler: "throw_q1", status: "failed", error: { origin: "runtime" } },
          { side: "a", handler: "throw_q1", status: "success" },
        ])
      },
    )
  },
}
