import { defineTool } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { gate, ok, quiet, type Scenario, stubTool, toolResults } from "../harness.ts"
import { usingDualPeer } from "./fixtures.ts"

const LOST_CLOSING =
  "Spindle lost the execution before it stored a result for this call. It does not know whether the tool ran, and it did not run the tool again."

export const T13: Scenario = {
  name: "T13 (rules 12, §3) closes side B's open tool calls with CLOSING.lost and resets session_turns on execution_lost",
  requirements: ["286367b3", "47d9e86c"],
  run: async (driver) => {
    const entered = gate()
    const leave = gate()
    const tools = {
      b_done: stubTool("Completes on side B", "finished before crash"),
      b_open: defineTool({
        description: "Blocks until recovery simulates a crash",
        execute: async () => {
          entered.release()
          await leave.opened
          return ok("late")
        },
      }),
    }
    const providerA = new ScriptedProvider([{ text: "A1" }, { text: "A2" }])
    const providerB = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c_done", name: "b_done", arguments: {} },
          { id: "c_open", name: "b_open", arguments: {} },
        ],
      },
      { text: "B2" },
    ])
    await usingDualPeer(
      driver,
      {
        providerA,
        providerB,
        tools,
        promptA: { tools: [] },
        promptB: { tools: ["b_done", "b_open"] },
        agent: { maxSessionTurns: 2 },
      },
      async (session, thread, peer) => {
        const run = quiet(session.send(thread, "first"))
        await Promise.race([
          entered.opened,
          quiet(
            run.then((outcome) => {
              throw new Error(`run settled before entering b_open: ${outcome.status} (${outcome.reason})`)
            }),
          ),
        ])
        try {
          await peer.forceRecover(thread)
        } finally {
          leave.release()
        }
        await run.catch(() => undefined)
        const afterCrash = await peer.inspect(thread)
        expect(afterCrash.status).toMatchObject({ state: "failed", reason: "execution_lost" })
        const stored = await peer.messages(thread)
        expect(toolResults(stored).map((m) => [m.tool_call_id, m.tool_status, m.prompt, m.content])).toEqual([
          ["c_done", "success", "reviewer", "finished before crash"],
          ["c_open", "error", "reviewer", LOST_CLOSING],
        ])
        const bCaller = afterCrash.messages.find((m) => m.role === "user" && m.content === null)
        expect(toolResults(afterCrash.messages).map((m) => m.callerSeq)).toEqual([bCaller?.seq, bCaller?.seq])
        // session_turns reset to 0 on execution_lost, so the next session runs a full 2 turns (A2 then B2).
        expect(await peer.send(thread, "after crash")).toMatchObject({
          status: "idle",
          reason: "max_session_turns",
          steps: 2,
        })
      },
    )
  },
}
