import { definePrompt, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { ok, type Scenario, statusOf, stubTool, toolResults, using } from "../harness.ts"
import { forceTool } from "../sides/fixtures.ts"
import { handlerOf, sendWith, usingHandler, usingHandlerPeer } from "./fixtures.ts"

const NOT_RUN = "Spindle did not run this call, because the execution was stopped before the call started."

export const HD10: Scenario = {
  name: "HD10 (rules 9, 10, 11, 12) counts handler turns uniformly toward maxSessionTurns with zero steps, keeps queued work pending, and resets for a new session",
  requirements: ["b3f24116", "47d9e86c", "35afe886", "bc5ba253", "16911055", "1a0354bc"],
  run: async (driver) => {
    // Part 1: prompt x handler with maxSessionTurns: 3.
    // Prompt A takes a 2-step turn (1 session turn, 2 messages persisted). Handler B takes 2 turns (session turns 2 & 3).
    // Even if Handler B injects a reply and queues another message on turn 3, maxSessionTurns stops the session!
    const seenB: Array<string | null> = []
    const replying_b = handlerOf(async (state, message) => {
      seenB.push(message.content)
      if (message.content === "A2") {
        await state.injectMessage({ role: "user", content: "B-reply-at-cap" })
        await state.queueMessage({ role: "user", content: "queued-for-next-session" })
      }
    })
    const providerA = new ScriptedProvider([
      { text: "A1", toolCalls: [{ id: "c1", name: "work", arguments: {} }] },
      { text: "A2" },
      { text: "A-session-2" },
    ])
    await usingHandler(
      driver,
      {
        sideA: { prompt: "worker" },
        sideB: { handler: "replying_b" },
        provider: providerA,
        prompts: [
          definePrompt({
            name: "worker",
            toolDescription: "Prompt A",
            model: "scripted",
            prompt: "You are A.",
            includeChat: true,
            tools: ["work"],
          }),
        ],
        tools: { work: stubTool("Work", "worked") },
        handlers: { replying_b },
        agent: { maxSessionTurns: 3 },
      },
      async (session, thread) => {
        const first = await sendWith(session, thread, "session-1")
        expect(first).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 2 })
        expect(seenB).toEqual(["A1", "A2"])
        expect(providerA.requests).toHaveLength(2)
        const atCap = await session.inspect(thread)
        expect(atCap.terminated).toBeNull()
        expect(atCap.queue.map((e) => (JSON.parse(e.payload) as { content?: string }).content)).toEqual([
          "queued-for-next-session",
        ])

        // New session starts from 0 with history intact and drains pending queue.
        const second = await sendWith(session, thread, "session-2")
        expect(second).toMatchObject({ status: "idle", reason: "handler_idle", steps: 1 })
        expect(seenB).toEqual(["A1", "A2", "A-session-2"])
        expect((await session.inspect(thread)).queue).toEqual([])
      },
    )

    // Part 2: durable maxSessionTurns on handler x human across sends and peers.
    const seenHuman: Array<string | null> = []
    const counter_handler = handlerOf(async (_state, message) => {
      seenHuman.push(message.content)
    })
    await usingHandlerPeer(
      driver,
      {
        sideA: { handler: "counter_handler" },
        sideB: { human: true },
        handlers: { counter_handler },
        agent: { maxSessionTurns: 2 },
      },
      async (session, thread, peer) => {
        expect(await sendWith(session, thread, "m1")).toMatchObject({
          status: "idle",
          reason: "handler_idle",
          steps: 0,
        })
        expect(await sendWith(peer, thread, "m2")).toMatchObject({
          status: "idle",
          reason: "max_session_turns",
          steps: 0,
        })
        expect((await peer.inspect(thread)).terminated).toBeNull()
        // New session starts at 0.
        expect(await sendWith(session, thread, "m3")).toMatchObject({
          status: "idle",
          reason: "handler_idle",
          steps: 0,
        })
        expect(await sendWith(peer, thread, "m4")).toMatchObject({
          status: "idle",
          reason: "max_session_turns",
          steps: 0,
        })
        expect(seenHuman).toEqual(["m1", "m2", "m3", "m4"])
      },
    )
  },
}

export const HD11: Scenario = {
  name: "HD11 (rule 13, §3) stops an uncapped handler x handler ping-pong at turnCap with max_total_turns and leaves queued work pending",
  requirements: ["409ce981", "3df00a7e"],
  run: async (driver) => {
    let turnsA = 0
    let turnsB = 0
    const ping_a = handlerOf(async (state, message) => {
      turnsA += 1
      if (turnsA === 2) {
        await state.queueMessage({ role: "user", content: "parked-at-cap" })
      }
      await state.injectMessage({ role: "assistant", content: `a-${turnsA}:${message.content}` })
    })
    const ping_b = handlerOf(async (state, message) => {
      turnsB += 1
      await state.injectMessage({ role: "user", content: `b-${turnsB}:${message.content}` })
    })
    await usingHandler(
      driver,
      {
        sideA: { handler: "ping_a" },
        sideB: { handler: "ping_b" },
        handlers: { ping_a, ping_b },
      },
      async (session, thread) => {
        const capped = await sendWith(session, thread, "start", { turnCap: 5 })
        expect(capped).toMatchObject({
          status: "idle",
          reason: "max_total_turns",
          steps: 0,
          modelCalls: [],
        })
        expect(turnsA + turnsB).toBe(5)
        expect([turnsA, turnsB]).toEqual([3, 2])
        expect(capped.handlerCalls).toHaveLength(5)
        const inspected = await session.inspect(thread)
        expect(inspected.status).toMatchObject({ state: "idle", reason: "max_total_turns" })
        expect(inspected.terminated).toBeNull()
        expect(inspected.queue.map((e) => (JSON.parse(e.payload) as { content?: string }).content)).toEqual([
          "parked-at-cap",
        ])

        // The first run takes "parked-at-cap". The waiting sender reclaims for "again" (rules 63–65).
        const resumed = await sendWith(session, thread, "again", { turnCap: 2 })
        expect(resumed).toMatchObject({ status: "idle", reason: "max_total_turns", steps: 0 })
        expect(turnsA + turnsB).toBe(9)
        expect(resumed.handlerCalls).toHaveLength(2)
        const messages = await session.messages(thread)
        expect(resumed.handlerCalls?.[0]?.messageId).toBe(messages.find((m) => m.content === "again")?.id)
        expect((await session.inspect(thread)).queue).toEqual([])
      },
    )
  },
}

export const HD12: Scenario = {
  name: "HD12 (rules 14, 18) root-thread state.stopSession() ends the session with state_stop_session, resets session_turns, gives sibling tools notRun, ignores forceTurn, keeps thread open, and rejects at rest",
  requirements: ["00d791ec", "1a0354bc"],
  run: async (driver) => {
    // Part 1: handler calls state.stopSession() on a root thread, plus at-rest rejection.
    let handlerCount = 0
    const stopper_a = handlerOf(async (state, message) => {
      handlerCount += 1
      if (message.content === "B1") {
        await state.injectMessage({ role: "assistant", content: "closing note" })
        state.execution?.forceTurn("b")
        await state.queueMessage({ role: "user", content: "queued-for-next-session" })
        await state.stopSession({ result: "done", notifyParent: "root-noop", status: "done" })
        return
      }
      if (message.content === "start") {
        await state.injectMessage({ role: "assistant", content: "A1" })
      }
    })
    const providerB = new ScriptedProvider([{ text: "B1" }, { text: "B-never" }])
    await usingHandler(
      driver,
      {
        sideA: { handler: "stopper_a" },
        sideB: { prompt: "reviewer" },
        provider: providerB,
        prompts: [
          definePrompt({
            name: "reviewer",
            toolDescription: "Prompt B",
            model: "scripted",
            prompt: "You are B.",
          }),
        ],
        handlers: { stopper_a },
        agent: { maxSessionTurns: 4 },
      },
      async (session, thread) => {
        // Calling stopSession() at rest (state.execution === null) rejects (and not with the M1 stub message).
        const rest = await session.state(thread)
        const atRestOutcome = await rest.stopSession().then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        expect(atRestOutcome).not.toBe("resolved")
        expect(atRestOutcome).not.toMatch(/not available in this version/i)

        // Turn 1: handler A -> Turn 2: prompt B ("B1") -> Turn 3: handler A calls stopSession() + forceTurn("b").
        const stopped = await sendWith(session, thread, "start")
        expect(stopped).toMatchObject({ status: "idle", reason: "state_stop_session", steps: 1 })
        expect(await statusOf(session, thread)).toMatchObject({ state: "idle", reason: "state_stop_session" })
        expect(providerB.requests).toHaveLength(1)
        const afterStop = await session.inspect(thread)
        expect(afterStop.terminated).toBeNull()
        expect(afterStop.queue.map((e) => (JSON.parse(e.payload) as { content?: string }).content)).toEqual([
          "queued-for-next-session",
        ])
        expect((await session.messages(thread)).map((m) => [m.role, m.content])).toEqual([
          ["user", "start"],
          ["assistant", "A1"],
          ["user", "B1"],
          ["assistant", "closing note"],
        ])

        // session_turns reset to 0, so a new session can take 4 full handler turns before max_session_turns.
        // Turn 1 drains "queued-for-next-session" + turn 2 takes "n1", then "n2" (turn 3), then "n3" (turn 4 -> cap).
        expect(await sendWith(session, thread, "n1")).toMatchObject({ status: "idle", reason: "handler_idle" })
        expect(await sendWith(session, thread, "n2")).toMatchObject({ status: "idle", reason: "handler_idle" })
        expect(await sendWith(session, thread, "n3")).toMatchObject({ status: "idle", reason: "max_session_turns" })
        expect(handlerCount).toBe(6)
      },
    )

    // Part 2: prompt tool calls state.stopSession() -> remaining sibling tool gets notRun, forceTurn ignored,
    // session_turns resets, and thread stays open.
    let siblingRan = false
    const tools = {
      end_session: defineTool({
        description: "End the active session",
        execute: async (state: ThreadState) => {
          state.execution?.forceTurn("a")
          await state.stopSession({ result: "finished" })
          return ok("session ended")
        },
      }),
      sibling: defineTool({
        description: "Should not run after stopSession",
        execute: async () => {
          siblingRan = true
          return ok("sibling ran")
        },
      }),
      force_a: forceTool("a"),
    }
    const provider = new ScriptedProvider([
      { text: "turn 1" },
      {
        toolCalls: [
          { id: "c_stop", name: "end_session", arguments: {} },
          { id: "c_sib", name: "sibling", arguments: {} },
        ],
      },
      { text: "new session turn 1" },
      { text: "new session turn 2" },
    ])
    await using(driver, { provider, tools, agent: { maxSessionTurns: 2 } }, async (session, thread) => {
      expect(await session.send(thread, "m1")).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      const ended = await session.send(thread, "m2")
      expect(ended).toMatchObject({ status: "idle", reason: "state_stop_session", steps: 1 })
      expect(siblingRan).toBe(false)
      expect((await session.inspect(thread)).terminated).toBeNull()
      expect(
        toolResults(await session.messages(thread)).map((m) => [m.tool_call_id, m.tool_status, m.content]),
      ).toEqual([
        ["c_stop", "success", "session ended"],
        ["c_sib", "error", NOT_RUN],
      ])
      // session_turns was reset to 0 on state_stop_session, so 2 full turns run before max_session_turns.
      expect(await session.send(thread, "m3")).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      expect(await session.send(thread, "m4")).toMatchObject({
        status: "idle",
        reason: "max_session_turns",
        steps: 1,
      })
    })
  },
}
