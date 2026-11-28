import { describe, expect, it } from "@effect/vitest"
import { defineTool, type PromptSide, type ThreadState } from "@standardagents/spec"
import { Effect, Layer } from "effect"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { ok, project, type Setup, stubTool } from "../../../conformance/src/scenarios/harness.ts"
import { type DualSetup, dualProject, forceTool } from "../../../conformance/src/scenarios/sides/fixtures.ts"
import { STOP_RULES, type StepFacts, stopReason } from "../../src/execution/stop-rules.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage, stateAtRest } from "../../src/execution/trigger.ts"
import { layer as storeLayer } from "../../src/store/sqlite.ts"
import { registryOf } from "../spindle-driver.ts"

const side = (extra: Partial<PromptSide> = {}): PromptSide => ({ prompt: "assistant", ...extra })

const step = (extra: Partial<StepFacts> = {}): StepFacts => ({
  text: null,
  calls: [],
  sideSteps: 1,
  totalSteps: 1,
  ...extra,
})

const finish = [{ name: "finish" }]

describe("stop rules", () => {
  it("orders the rules stopTool, stopOnResponse, maxSteps, then the runtime step cap", () => {
    expect(STOP_RULES.map((rule) => rule.reason)).toEqual([
      "stop_tool",
      "stop_on_response",
      "max_side_steps",
      "max_total_steps",
    ])
  })

  it("stop_tool matches a step that calls the side's stopTool, and no other step", () => {
    expect(stopReason(step({ calls: [{ name: "note" }, ...finish] }), side({ stopTool: "finish" }), 100)).toBe(
      "stop_tool",
    )
    expect(stopReason(step({ calls: [{ name: "note" }] }), side({ stopTool: "finish" }), 100)).toBeUndefined()
    expect(stopReason(step({ calls: finish }), side(), 100)).toBeUndefined()
  })

  it("stop_on_response matches text without calls by default, and never empty text, calls, or a false setting", () => {
    expect(stopReason(step({ text: "hello" }), side(), 100)).toBe("stop_on_response")
    expect(stopReason(step({ text: "hello" }), side({ stopOnResponse: true }), 100)).toBe("stop_on_response")
    expect(stopReason(step({ text: "hello" }), side({ stopOnResponse: false }), 100)).toBeUndefined()
    expect(stopReason(step({ text: "hello", calls: [{ name: "note" }] }), side(), 100)).toBeUndefined()
    for (const text of [null, "", " \n"]) expect(stopReason(step({ text }), side(), 100)).toBeUndefined()
  })

  it("max_side_steps matches once the side has taken maxSteps steps", () => {
    expect(stopReason(step({ calls: [{ name: "note" }], sideSteps: 3 }), side({ maxSteps: 3 }), 100)).toBe(
      "max_side_steps",
    )
    expect(stopReason(step({ calls: [{ name: "note" }], sideSteps: 2 }), side({ maxSteps: 3 }), 100)).toBeUndefined()
  })

  it("max_total_steps matches once the execution reaches the runtime step cap", () => {
    expect(stopReason(step({ calls: [{ name: "note" }], totalSteps: 100 }), side(), 100)).toBe("max_total_steps")
    expect(stopReason(step({ calls: [{ name: "note" }], totalSteps: 99 }), side(), 100)).toBeUndefined()
  })

  it("stop_tool wins over max_side_steps when both match", () => {
    expect(stopReason(step({ calls: finish, sideSteps: 1 }), side({ stopTool: "finish", maxSteps: 1 }), 100)).toBe(
      "stop_tool",
    )
  })

  it("stop_tool wins over max_total_steps when both match", () => {
    expect(stopReason(step({ calls: finish, totalSteps: 5 }), side({ stopTool: "finish" }), 5)).toBe("stop_tool")
  })

  it("stop_on_response wins over max_side_steps when both match", () => {
    expect(stopReason(step({ text: "done", sideSteps: 1 }), side({ maxSteps: 1 }), 100)).toBe("stop_on_response")
  })

  it("stop_on_response wins over max_total_steps when both match", () => {
    expect(stopReason(step({ text: "done", totalSteps: 5 }), side(), 5)).toBe("stop_on_response")
  })

  it("max_side_steps wins over max_total_steps when both match", () => {
    expect(stopReason(step({ calls: [{ name: "note" }], sideSteps: 5, totalSteps: 5 }), side({ maxSteps: 5 }), 5)).toBe(
      "max_side_steps",
    )
  })

  it("stop_tool and stop_on_response never match one step, because a response stop needs a step without calls", () => {
    const both = side({ stopTool: "finish" })
    expect(stopReason(step({ text: "done", calls: finish }), both, 100)).toBe("stop_tool")
    expect(STOP_RULES[1]?.applies(step({ text: "done", calls: finish }), both, 100)).toBe(false)
  })
})

const runSingle = (setup: Setup, options?: { readonly stepCap?: number }) =>
  Effect.gen(function* () {
    const thread = yield* createThread("assistant")
    const { outcome } = yield* sendMessage(thread.id, "go", options)
    return outcome
  }).pipe(
    Effect.provide(
      Layer.merge(
        registryOf(project(setup)),
        Layer.provideMerge(
          supervisorLayer(),
          Layer.fresh(storeLayer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))),
        ),
      ),
    ),
  )

const runDual = (setup: DualSetup, options?: { readonly stepCap?: number }) =>
  Effect.gen(function* () {
    const thread = yield* createThread("pair")
    const { outcome } = yield* sendMessage(thread.id, "go", options)
    return outcome
  }).pipe(
    Effect.provide(
      Layer.merge(
        registryOf(dualProject(setup)),
        Layer.provideMerge(
          supervisorLayer(),
          Layer.fresh(storeLayer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))),
        ),
      ),
    ),
  )

describe("turn-boundary precedence (rules 14, 15)", () => {
  it.effect("rule 14.1: cooperative stop() wins over forceTurn, stopTool, maxSteps, maxSessionTurns, and stepCap", () =>
    Effect.gen(function* () {
      const stopAndForce = defineTool({
        description: "Call forceTurn and stop together",
        execute: async (state: ThreadState) => {
          state.execution?.forceTurn("b")
          state.execution?.stop()
          return ok("stopped")
        },
      })
      const providerA = new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "stop_and_force", arguments: {} }] }])
      const providerB = new ScriptedProvider([{ text: "never runs" }])
      const outcome = yield* runDual(
        {
          providerA,
          providerB,
          tools: { stop_and_force: stopAndForce },
          sideA: { stopTool: "stop_and_force", maxSteps: 1 },
          agent: { maxSessionTurns: 1 },
        },
        { stepCap: 1 },
      )
      expect(outcome).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
      expect(providerB.requests).toHaveLength(0)
    }),
  )

  it.effect("rule 14.3 vs 14.4: forceTurn takes precedence over stopTool and maxSteps on the same step", () =>
    Effect.gen(function* () {
      const providerA = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c1", name: "force_a", arguments: {} },
            { id: "c2", name: "finish", arguments: {} },
          ],
        },
        { text: "A took forced turn 2" },
      ])
      const providerB = new ScriptedProvider([{ text: "never runs" }])
      const outcome = yield* runDual({
        providerA,
        providerB,
        tools: { force_a: forceTool("a"), finish: stubTool("Finish", "done") },
        sideA: { stopTool: "finish", maxSteps: 1 },
        agent: { maxSessionTurns: 2 },
      })
      expect(outcome).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 2 })
      expect([providerA.requests.length, providerB.requests.length]).toEqual([2, 0])
    }),
  )

  it.effect("rule 14.3 + rule 10: forceTurn increments session_turns and checks maxSessionTurns before switching", () =>
    Effect.gen(function* () {
      const providerA = new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "force_b", arguments: {} }] }])
      const providerB = new ScriptedProvider([{ text: "never runs" }])
      const outcome = yield* runDual({
        providerA,
        providerB,
        tools: { force_b: forceTool("b") },
        agent: { maxSessionTurns: 1 },
      })
      expect(outcome).toMatchObject({ status: "idle", reason: "max_session_turns", steps: 1 })
      expect(providerB.requests).toHaveLength(0)
    }),
  )

  it.effect(
    "rule 14.4 + rule 10: stopTool, stopOnResponse, and maxSteps yield to maxSessionTurns when the cap fires",
    () =>
      Effect.gen(function* () {
        const tools = { finish: stubTool("Finish", "done"), work: stubTool("Work", "worked") }
        const toolOut = yield* runSingle({
          provider: new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "finish", arguments: {} }] }]),
          tools,
          side: { stopTool: "finish" },
          agent: { maxSessionTurns: 1 },
        })
        const textOut = yield* runSingle({
          provider: new ScriptedProvider([{ text: "done" }]),
          tools,
          agent: { maxSessionTurns: 1 },
        })
        const stepsOut = yield* runSingle({
          provider: new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "work", arguments: {} }] }]),
          tools,
          side: { stopOnResponse: false, maxSteps: 1 },
          agent: { maxSessionTurns: 1 },
        })
        expect([toolOut?.reason, textOut?.reason, stepsOut?.reason]).toEqual([
          "max_session_turns",
          "max_session_turns",
          "max_session_turns",
        ])
      }),
  )

  it.effect(
    "rule 14.5: stepCap runs last, stopping with max_total_steps only when execution would otherwise continue",
    () =>
      Effect.gen(function* () {
        const tools = { force_a: forceTool("a"), force_b: forceTool("b"), finish: stubTool("Finish", "done") }
        // Forcing the same prompt side would continue to another turn -> stepCap wins.
        const forcedSame = yield* runSingle(
          { provider: new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "force_a", arguments: {} }] }]), tools },
          { stepCap: 1 },
        )
        // Forcing the human side ends the run -> forced_human_turn wins over stepCap.
        const forcedHuman = yield* runSingle(
          { provider: new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "force_b", arguments: {} }] }]), tools },
          { stepCap: 1 },
        )
        // Switching to opposite prompt side would continue -> stepCap wins.
        const switchPrompt = yield* runDual(
          {
            providerA: new ScriptedProvider([{ text: "from A" }]),
            providerB: new ScriptedProvider([{ text: "never runs" }]),
          },
          { stepCap: 1 },
        )
        // Hitting maxSessionTurns on the same step as stepCap -> max_session_turns wins.
        const sessionCap = yield* runDual(
          {
            providerA: new ScriptedProvider([{ text: "from A" }]),
            providerB: new ScriptedProvider([{ text: "from B" }]),
            agent: { maxSessionTurns: 2 },
          },
          { stepCap: 2 },
        )
        expect([forcedSame?.reason, forcedHuman?.reason, switchPrompt?.reason, sessionCap?.reason]).toEqual([
          "max_total_steps",
          "forced_human_turn",
          "max_total_steps",
          "max_session_turns",
        ])
      }),
  )

  it.effect("rule 15: human-side handoff reports forced_human_turn, ordinary stop reason, or awaiting_human", () =>
    Effect.gen(function* () {
      const tools = { force_b: forceTool("b"), finish: stubTool("Finish", "done") }
      const forced = yield* runSingle({
        provider: new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "force_b", arguments: {} }] }]),
        tools,
        side: { stopOnResponse: false },
      })
      const ordinary = yield* runSingle({
        provider: new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "finish", arguments: {} }] }]),
        tools,
        side: { stopTool: "finish" },
      })
      const awaiting = yield* Effect.gen(function* () {
        const thread = yield* createThread("assistant")
        const state = yield* stateAtRest(thread.id)
        yield* Effect.promise(() => state.queueMessage({ role: "assistant", content: "for human" }))
        const supervisor = yield* ThreadSupervisor
        return yield* supervisor.settled(thread.id)
      })
      expect([forced?.reason, ordinary?.reason, awaiting?.reason]).toEqual([
        "forced_human_turn",
        "stop_tool",
        "awaiting_human",
      ])
    }).pipe(
      Effect.provide(
        Layer.merge(
          registryOf(project({ provider: new ScriptedProvider([]) })),
          Layer.provideMerge(
            supervisorLayer(),
            Layer.fresh(storeLayer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))),
          ),
        ),
      ),
    ),
  )
})
