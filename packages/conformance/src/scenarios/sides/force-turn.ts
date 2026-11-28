import { defineHook, defineTool, type ExecutionState, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { ok, type Scenario, SIDES, statusOf, stubTool, toolResults, using } from "../harness.ts"
import { forceTool, probeTool, usingDual } from "./fixtures.ts"

const syncTag = (call: () => void): string => {
  try {
    call()
    return "no-throw"
  } catch (error) {
    return typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : `untyped: ${error instanceof Error ? error.message : String(error)}`
  }
}

export const T09: Scenario = {
  name: "T09 (rules 14, 16) forceTurn routes to the opposite prompt side without aborting siblings and forces the same side into a fresh turn",
  requirements: ["0b7bee20", "7d581abd"],
  run: async (driver) => {
    const events: Array<string> = []
    const tools = {
      kick_b: forceTool("b", () => events.push("kick_b")),
      sibling: defineTool({
        description: "Runs after forceTurn in the same step",
        execute: async () => {
          events.push("sibling")
          return ok("sibling ran")
        },
      }),
    }
    const providerA = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "kick_b", arguments: {} },
          { id: "c2", name: "sibling", arguments: {} },
        ],
      },
    ])
    const providerB = new ScriptedProvider([{ text: "B answered" }])
    await usingDual(
      driver,
      {
        providerA,
        providerB,
        tools,
        sideA: { stopOnResponse: false },
        agent: { maxSessionTurns: 2 },
      },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({
          status: "idle",
          reason: "max_session_turns",
          steps: 2,
        })
        expect(events).toEqual(["kick_b", "sibling"])
        expect(toolResults(await session.messages(thread)).map((m) => m.content)).toEqual(["forced b", "sibling ran"])
      },
    )
    expect([providerA.requests.length, providerB.requests.length]).toEqual([1, 1])
    // Forcing the same side starts a fresh turn with sideSteps reset to 0 and runs without a new message.
    const probes: Array<unknown> = []
    const sameTools = {
      probe: probeTool(probes, () => "probed"),
      again_a: forceTool("a"),
    }
    const sameProvider = new ScriptedProvider([
      { toolCalls: [{ id: "s1", name: "probe", arguments: {} }] },
      { toolCalls: [{ id: "s2", name: "again_a", arguments: {} }] },
      { toolCalls: [{ id: "s3", name: "probe", arguments: {} }] },
      { toolCalls: [{ id: "s4", name: "probe", arguments: {} }] },
    ])
    await using(
      driver,
      { provider: sameProvider, tools: sameTools, side: { stopOnResponse: false, maxSteps: 2 } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "max_side_steps", steps: 4 })
      },
    )
    expect(probes.map((p) => (p as Array<unknown>).slice(1))).toEqual([
      ["a", ["assistant"], 1, 1, 0],
      ["a", ["assistant"], 3, 3, 0],
      ["a", ["assistant"], 4, 4, 0],
    ])
  },
}

export const T10: Scenario = {
  name: "T10 (rules 14, 15) forceTurn targeting a human side settles forced_human_turn, yields to maxSessionTurns, and is ignored by stop()",
  requirements: ["0b7bee20", "1a0354bc"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const tools = {
        to_human: forceTool(humanOn),
        finish: stubTool("Finish", "finished"),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c1", name: "to_human", arguments: {} },
            { id: "c2", name: "finish", arguments: {} },
          ],
        },
      ])
      await using(
        driver,
        { provider, tools, humanOn, side: { stopOnResponse: false, stopTool: "finish" } },
        async (session, thread) => {
          expect(await session.send(thread, "go", { stepCap: 1 })).toMatchObject({
            status: "idle",
            reason: "forced_human_turn",
            steps: 1,
          })
          expect(await statusOf(session, thread)).toMatchObject({ state: "idle", reason: "forced_human_turn" })
          expect(toolResults(await session.messages(thread)).map((m) => m.content)).toEqual([
            `forced ${humanOn}`,
            "finished",
          ])
        },
      )
    }
    // Rule 14.3 + Rule 10: maxSessionTurns is checked after forceTurn increments session_turns.
    const cappedProvider = new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "to_human", arguments: {} }] }])
    await using(
      driver,
      { provider: cappedProvider, tools: { to_human: forceTool("b") }, agent: { maxSessionTurns: 1 } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({
          status: "idle",
          reason: "max_session_turns",
          steps: 1,
        })
      },
    )
    // Rule 14.1: cooperative stop() wins over forceTurn and never switches sides.
    const stopAndForce = defineTool({
      description: "Force B and stop",
      execute: async (state: ThreadState) => {
        state.execution?.forceTurn("b")
        state.execution?.stop()
        return ok("both")
      },
    })
    const dualA = new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "stop_and_force", arguments: {} }] }])
    const dualB = new ScriptedProvider([{ text: "never runs" }])
    await usingDual(
      driver,
      { providerA: dualA, providerB: dualB, tools: { stop_and_force: stopAndForce } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
      },
    )
    expect(dualB.requests).toHaveLength(0)
  },
}

const verifyLastWriteWins = async (driver: Parameters<Scenario["run"]>[0], first: "a" | "b", second: "a" | "b") => {
  const tools = { force_a: forceTool("a"), force_b: forceTool("b") }
  const providerA = new ScriptedProvider([
    {
      toolCalls: [
        { id: "c1", name: `force_${first}`, arguments: {} },
        { id: "c2", name: `force_${second}`, arguments: {} },
      ],
    },
    { text: "A took turn 2" },
  ])
  const providerB = new ScriptedProvider([{ text: "B took turn 2" }])
  await usingDual(driver, { providerA, providerB, tools, agent: { maxSessionTurns: 2 } }, async (session, thread) => {
    expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 2 })
  })
  expect([providerA.requests.length, providerB.requests.length]).toEqual(second === "a" ? [2, 0] : [1, 1])
}

export const T11: Scenario = {
  name: "T11 (rules 14, §1.4, §3) forceTurn uses last-write-wins in a step and throws InvalidArguments synchronously for bad sides in tools and hooks",
  requirements: ["0b7bee20"],
  run: async (driver) => {
    await verifyLastWriteWins(driver, "b", "a")
    await verifyLastWriteWins(driver, "a", "b")
    const caught: Array<string> = []
    let savedExecution: ExecutionState | null = null
    const badHook = defineHook({
      hook: "after_create_message",
      id: "bad_force_hook",
      execute: async (state, message) => {
        if (message.role === "assistant" && message.content === "final")
          Reflect.apply(state.execution?.forceTurn as (...a: Array<unknown>) => void, state.execution, ["invalid"])
      },
    })
    const tools = {
      check_invalid: defineTool({
        description: "Test invalid sides and save execution handle",
        execute: async (state: ThreadState) => {
          savedExecution = state.execution
          for (const bad of ["c", "", null, 1])
            caught.push(
              syncTag(() =>
                Reflect.apply(state.execution?.forceTurn as (...a: Array<unknown>) => void, state.execution, [bad]),
              ),
            )
          return ok("checked")
        },
      }),
      uncaught_invalid: defineTool({
        description: "Throw InvalidArguments uncaught",
        execute: async (state: ThreadState) => {
          Reflect.apply(state.execution?.forceTurn as (...a: Array<unknown>) => void, state.execution, ["c"])
          return ok("unreachable")
        },
      }),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c_check", name: "check_invalid", arguments: {} },
          { id: "c_throw", name: "uncaught_invalid", arguments: {} },
        ],
      },
      { text: "final" },
    ])
    await using(
      driver,
      { provider, tools, hooks: [badHook], prompt: { hooks: ["bad_force_hook"] } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
        expect(caught).toEqual(["InvalidArguments", "InvalidArguments", "InvalidArguments", "InvalidArguments"])
        const results = toolResults(await session.messages(thread))
        expect(results.map((m) => [m.tool_call_id, m.tool_status])).toEqual([
          ["c_check", "success"],
          ["c_throw", "error"],
        ])
        expect(session.logs().some((line) => line.includes("bad_force_hook"))).toBe(true)
        const expired = syncTag(() =>
          Reflect.apply(
            (savedExecution as ExecutionState | null)?.forceTurn as (...a: Array<unknown>) => void,
            savedExecution,
            ["c"],
          ),
        )
        expect(expired).toMatch(/^(HandleExpired|ExecutionEnded)$/)
      },
    )
  },
}
