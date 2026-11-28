import { defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, ok, runTurn, type Scenario, stubTool, usingPeer } from "../harness.ts"
import { usingDual } from "./fixtures.ts"

export const T05: Scenario = {
  name: "T05 (rules 9, 10, 11) enforces maxSessionTurns on prompt x prompt, counts multi-step turns as one, keeps queued work pending, and resets",
  requirements: ["47d9e86c", "35afe886", "bc5ba253", "d80e4c71", "7b5d1f06", "1a0354bc"],
  run: async (driver) => {
    const tools = {
      work: stubTool("Work", "stepped"),
      park_next: defineTool({
        description: "Queue a message for the next session",
        execute: async (state: ThreadState) => {
          await state.queueMessage({ role: "user", content: "queued for session 2" })
          return ok("queued")
        },
      }),
    }
    const providerA = new ScriptedProvider([
      { toolCalls: [{ id: "a1", name: "work", arguments: {} }] },
      { toolCalls: [{ id: "a2", name: "work", arguments: {} }] },
      { text: "A finished turn 1" },
      { text: "A session 2" },
    ])
    const providerB = new ScriptedProvider([
      { toolCalls: [{ id: "b1", name: "park_next", arguments: {} }] },
      { text: "B finished turn 2" },
      { text: "B session 2" },
    ])
    await usingDual(
      driver,
      {
        providerA,
        providerB,
        tools,
        promptA: { includeChat: true, tools: ["work"] },
        promptB: { includeChat: true, tools: ["park_next"] },
        agent: { maxSessionTurns: 2 },
      },
      async (session, thread) => {
        const first = await session.send(thread, "session 1")
        expect(first).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 5 })
        const atCap = await session.inspect(thread)
        expect(atCap.status).toMatchObject({ state: "idle", reason: "max_session_turns" })
        expect(atCap.terminated).toBeNull()
        expect(atCap.queue.map((e) => (JSON.parse(e.payload) as { content?: string }).content)).toEqual([
          "queued for session 2",
        ])
        const second = await session.send(thread, "session 2")
        expect(second).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 2 })
        expect((await session.inspect(thread)).queue).toEqual([])
        expect(history(providerA.requests[3]).map((m) => m.content)).toContain("A finished turn 1")
        expect(history(providerA.requests[3]).map((m) => m.content)).toContain("queued for session 2")
      },
    )
  },
}

export const T06: Scenario = {
  name: "T06 (rules 9, 10, 11, 12) enforces durable maxSessionTurns across sends and peers on prompt x human and resets for a new session",
  requirements: ["47d9e86c", "35afe886", "bc5ba253"],
  run: async (driver) => {
    const stopper = defineTool({
      description: "Cooperatively stop the execution",
      execute: async (state: ThreadState) => {
        state.execution?.stop()
        return ok("stopping")
      },
    })
    const provider = new ScriptedProvider([
      { text: "reply 1" },
      { toolCalls: [{ id: "c_stop", name: "stopper", arguments: {} }] },
      { text: "reply 2" },
      { text: "reply 3" },
      { text: "reply 4" },
    ])
    await usingPeer(
      driver,
      { provider, tools: { stopper }, prompt: { includeChat: true }, agent: { maxSessionTurns: 2 } },
      async (session, thread, peer) => {
        expect(await session.send(thread, "m1")).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
        // Cooperative stop does not end the session and preserves session_turns (still 1).
        expect(await peer.send(thread, "m2")).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
        expect(await peer.send(thread, "m3")).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 1 })
        expect((await peer.state(thread)).terminated).toBeNull()
        // New session starts from 0 with history intact.
        expect(await session.send(thread, "m4")).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
        expect(history(provider.requests[3]).map((m) => m.content)).toContain("reply 1")
        expect(await peer.send(thread, "m5")).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 1 })
      },
    )
  },
}

export const T07: Scenario = {
  name: "T07 (rules 14, §3) stops an uncapped prompt x prompt loop at stepCap when neither model stops",
  requirements: ["d80e4c71", "7b5d1f06", "1a0354bc"],
  run: async (driver) => {
    const pingA = new ScriptedProvider([{ text: "a1" }, { text: "a2" }, { text: "a3" }])
    const pingB = new ScriptedProvider([{ text: "b1" }, { text: "b2" }, { text: "b3" }])
    await usingDual(driver, { providerA: pingA, providerB: pingB }, async (session, thread) => {
      expect(await session.send(thread, "go", { stepCap: 4 })).toMatchObject({
        status: "idle",
        reason: "max_total_steps",
        steps: 4,
      })
    })
    expect([pingA.requests.length, pingB.requests.length]).toEqual([2, 2])
    const endlessA = new ScriptedProvider([{ text: "a1" }, { text: "a2" }, { text: "a3" }, { text: "a4" }])
    const endlessB = new ScriptedProvider([{ text: "never" }])
    await usingDual(
      driver,
      {
        providerA: endlessA,
        providerB: endlessB,
        sideA: { stopOnResponse: false },
        sideB: { stopOnResponse: false },
      },
      async (session, thread) => {
        expect(await session.send(thread, "go", { stepCap: 3 })).toMatchObject({
          status: "idle",
          reason: "max_total_steps",
          steps: 3,
        })
      },
    )
    expect([endlessA.requests.length, endlessB.requests.length]).toEqual([3, 0])
  },
}

export const T08: Scenario = {
  name: "T08 (rule 14) checks stepCap last so stopTool, stopOnResponse, maxSteps, and maxSessionTurns win on the same step",
  requirements: ["35afe886", "bc5ba253", "d80e4c71", "7b5d1f06"],
  run: async (driver) => {
    const tools = { finish: stubTool("Finish", "done"), work: stubTool("Work", "worked") }
    const toolStop = new ScriptedProvider([{ toolCalls: [{ id: "c_f", name: "finish", arguments: {} }] }])
    expect(
      await runTurn(driver, { provider: toolStop, tools, side: { stopTool: "finish" } }, "go", { stepCap: 1 }),
    ).toMatchObject({ status: "idle", reason: "stop_tool", steps: 1 })
    const textStop = new ScriptedProvider([{ text: "done" }])
    expect(await runTurn(driver, { provider: textStop, tools }, "go", { stepCap: 1 })).toMatchObject({
      status: "idle",
      reason: "stop_on_response",
      steps: 1,
    })
    const sideLimit = new ScriptedProvider([{ toolCalls: [{ id: "c_w", name: "work", arguments: {} }] }])
    expect(
      await runTurn(driver, { provider: sideLimit, tools, side: { stopOnResponse: false, maxSteps: 1 } }, "go", {
        stepCap: 1,
      }),
    ).toMatchObject({ status: "idle", reason: "max_side_steps", steps: 1 })
    const dualA = new ScriptedProvider([{ text: "a1" }])
    const dualB = new ScriptedProvider([{ text: "b1" }])
    await usingDual(
      driver,
      { providerA: dualA, providerB: dualB, agent: { maxSessionTurns: 2 } },
      async (session, thread) => {
        expect(await session.send(thread, "go", { stepCap: 2 })).toMatchObject({
          status: "idle",
          reason: "max_session_turns",
          steps: 2,
        })
      },
    )
  },
}
