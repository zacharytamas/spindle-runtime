import { definePrompt } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { gate, quiet, type Scenario, stubTool } from "../harness.ts"
import { handlerOf, sendWith, usingHandlerPeer } from "./fixtures.ts"

export const HD15: Scenario = {
  name: "HD15 (rules 12, 20, 21, §3) never redelivers a message after forced recovery mid-handler and preserves undrained queued entries",
  requirements: ["0747a620", "78f43349", "47d9e86c"],
  run: async (driver) => {
    // Part 1 (rule 20): crash after dequeue + cursor advance during queued-message handler delivery.
    const entered = gate()
    const leave = gate()
    const seen: Array<string | null> = []
    const slow_handler = handlerOf(async (_state, message) => {
      seen.push(message.content)
      if (message.content === "in-flight") {
        entered.release()
        await leave.opened
      }
    })
    await usingHandlerPeer(
      driver,
      {
        sideA: { handler: "slow_handler" },
        sideB: { human: true },
        handlers: { slow_handler },
        agent: { maxSessionTurns: 3 },
      },
      async (session, thread, peer) => {
        // Take turn 1 so session_turns = 1 before the crash.
        expect(await sendWith(session, thread, "before-crash")).toMatchObject({
          status: "idle",
          reason: "handler_idle",
          steps: 0,
        })
        const running = quiet(sendWith(session, thread, "in-flight"))
        await Promise.race([
          entered.opened,
          quiet(
            running.then((out) => {
              throw new Error(`run settled before entering handler: ${out.status} (${out.reason})`)
            }),
          ),
        ])
        // Queue a second entry while "in-flight" holds the thread; its dequeue has not run.
        await (await peer.state(thread)).queueMessage({ role: "user", content: "still-pending" })
        try {
          await peer.forceRecover(thread)
        } finally {
          leave.release()
        }
        await running.catch(() => undefined)

        const afterCrash = await peer.inspect(thread)
        expect(afterCrash.status).toMatchObject({ state: "failed", reason: "execution_lost" })
        expect(afterCrash.messages.map((m) => m.content)).toEqual(["before-crash", "in-flight"])
        expect(afterCrash.queue.map((e) => (JSON.parse(e.payload) as { content?: string }).content)).toEqual([
          "still-pending",
        ])

        // Next send delivers "still-pending" and "after-crash" (2 turns), NEVER redelivering "in-flight".
        // session_turns reset to 0 on execution_lost, so 2 turns stay below maxSessionTurns: 3!
        expect(await sendWith(peer, thread, "after-crash")).toMatchObject({
          status: "idle",
          reason: "handler_idle",
          steps: 0,
        })
        expect(seen).toEqual(["before-crash", "in-flight", "still-pending", "after-crash"])
        // Turn 3 of the fresh session hits maxSessionTurns: 3.
        expect(await sendWith(peer, thread, "third-in-fresh")).toMatchObject({
          status: "idle",
          reason: "max_session_turns",
          steps: 0,
        })
      },
    )

    // Part 2 (rule 21): crash during prompt -> handler delivery after cursor advance for M1.
    const enteredM1 = gate()
    const leaveM1 = gate()
    const seenB: Array<string | null> = []
    const peer_handler = handlerOf(async (_state, message) => {
      seenB.push(message.content)
      if (message.content === "M1") {
        enteredM1.release()
        await leaveM1.opened
      }
    })
    const providerA = new ScriptedProvider([
      { text: "M1", toolCalls: [{ id: "c1", name: "work", arguments: {} }] },
      { text: "M2" },
      { text: "M3" },
    ])
    await usingHandlerPeer(
      driver,
      {
        sideA: { prompt: "worker" },
        sideB: { handler: "peer_handler" },
        provider: providerA,
        prompts: [
          definePrompt({
            name: "worker",
            toolDescription: "Prompt A",
            model: "scripted",
            prompt: "You are A.",
            tools: ["work"],
          }),
        ],
        tools: { work: stubTool("Work", "worked") },
        handlers: { peer_handler },
      },
      async (session, thread, peer) => {
        const running = quiet(sendWith(session, thread, "go"))
        await Promise.race([
          enteredM1.opened,
          quiet(
            running.then((out) => {
              throw new Error(`run settled before entering M1: ${out.status} (${out.reason})`)
            }),
          ),
        ])
        try {
          await peer.forceRecover(thread)
        } finally {
          leaveM1.release()
        }
        await running.catch(() => undefined)
        expect((await peer.inspect(thread)).status).toMatchObject({ state: "failed", reason: "execution_lost" })

        // Later send runs a fresh turn and never redelivers M1.
        expect(await sendWith(peer, thread, "fresh")).toMatchObject({
          status: "idle",
          reason: "handler_idle",
          steps: 1,
        })
        expect(seenB).toEqual(["M1", "M3"])
      },
    )
  },
}
