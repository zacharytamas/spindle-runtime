import { describe, expect, it } from "@effect/vitest"
import { defineTool, type ThreadState } from "@standardagents/spec"
import { Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { gate, ok, project } from "../../../conformance/src/scenarios/harness.ts"
import { admitEntry, drainEntries, settleRun, startRun } from "../../scripts/store-fixtures.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage, stateAtRest } from "../../src/execution/trigger.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf } from "../spindle-driver.ts"

import { claim, inMemory, storeAt, withDatabaseFile } from "./contract-fixtures.ts"

describe("ThreadStore", () => {
  describe("run status", () => {
    it.effect("setStatus changes since only when the state or the reason changes", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* TestClock.adjust("1 second")
        const running = yield* startRun(thread.id, claim)
        expect(running).toEqual({ state: "running", since: 1_000_000, reason: null })
        yield* TestClock.adjust("1 second")
        expect(yield* startRun(thread.id, claim)).toEqual(running)
        yield* TestClock.adjust("1 second")
        const idle = yield* settleRun(thread.id, claim, { state: "idle", reason: "stop_on_response" })
        expect(idle).toEqual({ state: "idle", since: 3_000_000, reason: "stop_on_response" })
        yield* TestClock.adjust("1 second")
        expect(yield* settleRun(thread.id, claim, { state: "idle", reason: "stop_on_response" })).toEqual(idle)
        yield* TestClock.adjust("1 second")
        yield* startRun(thread.id, claim)
        const stopTool = yield* settleRun(thread.id, claim, { state: "idle", reason: "stop_tool" })
        expect(stopTool).toEqual({ state: "idle", since: 5_000_000, reason: "stop_tool" })
        expect((yield* store.getThread(thread.id)).status).toEqual(stopTool)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("the run status survives a restart with its since time, including a failed execution_lost status", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const written = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            const thread = yield* store.createThread({ agentId: "assistant" })
            yield* TestClock.adjust("1 second")
            yield* startRun(thread.id, claim)
            yield* TestClock.adjust("1 second")
            const status = yield* settleRun(thread.id, claim, { state: "failed", reason: "execution_lost" })
            return { threadId: thread.id, status }
          }).pipe(Effect.provide(storeAt(filename)))
          expect(written.status).toEqual({ state: "failed", since: 2_000_000, reason: "execution_lost" })
          yield* TestClock.adjust("1 second")
          const status = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            return (yield* store.getThread(written.threadId)).status
          }).pipe(Effect.provide(storeAt(filename)))
          expect(status).toEqual(written.status)
        }),
      ),
    )
  })

  describe("queue", () => {
    it.effect("enqueue and takeQueue keep messages and tool calls in arrival order and empty the queue", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const other = yield* store.createThread({ agentId: "assistant" })
        yield* admitEntry(thread.id, { kind: "message", message: { role: "user", content: "first" } }, claim)
        yield* admitEntry(other.id, { kind: "message", message: { role: "user", content: "elsewhere" } }, claim)
        yield* admitEntry(thread.id, { kind: "tool", toolName: "lookup", args: { q: "x" } }, claim)
        yield* admitEntry(
          thread.id,
          {
            kind: "message",
            message: { role: "assistant", content: "third", silent: true },
          },
          claim,
        )
        const taken = yield* drainEntries(thread.id, claim.flowId)
        expect(taken.map(({ seq: _, queuedAt: __, ...entry }) => entry)).toEqual([
          { kind: "message", message: { role: "user", content: "first" } },
          { kind: "tool", toolName: "lookup", args: { q: "x" } },
          { kind: "message", message: { role: "assistant", content: "third", silent: true } },
        ])
        expect(yield* drainEntries(thread.id, claim.flowId)).toEqual([])
        expect((yield* drainEntries(other.id, claim.flowId)).length).toBe(1)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("takeQueue inside a failed transaction leaves the entries queued", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* admitEntry(thread.id, { kind: "tool", toolName: "lookup", args: {} }, claim)
        yield* Effect.flip(
          store.transaction(Effect.andThen(drainEntries(thread.id, claim.flowId), Effect.fail("crash"))),
        )
        expect((yield* drainEntries(thread.id, claim.flowId)).length).toBe(1)
      }).pipe(Effect.provide(inMemory)),
    )
  })

  describe("session turns (rules 9, 10, 12)", () => {
    const readSessionTurns = (threadId: string) =>
      SqlClient.use((sql) =>
        Effect.map(
          sql<{ session_turns: number }>`SELECT session_turns FROM threads WHERE id = ${threadId}`,
          (rows) => rows[0]?.session_turns,
        ),
      )

    it.effect("migration 0007 initializes threads.session_turns to 0", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        expect(yield* readSessionTurns(thread.id)).toBe(0)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "rule 12: RunStore.settle and recovery reset session_turns on session-ending settlements and preserve it on pausing settlements",
      () =>
        Effect.gen(function* () {
          const threads = yield* ThreadStore
          const runs = yield* RunStore
          const sql = yield* SqlClient
          const resetReasons: ReadonlyArray<readonly ["idle" | "failed", string]> = [
            ["idle", "max_session_turns"],
            ["idle", "state_stop_session"],
            ["idle", "session_stop"],
            ["failed", "session_fail"],
            ["failed", "step_error"],
            ["failed", "fatal_error"],
            ["failed", "execution_lost"],
          ]
          const preserveReasons: ReadonlyArray<readonly ["idle" | "failed", string]> = [
            ["idle", "stop_on_response"],
            ["idle", "stop_tool"],
            ["idle", "max_side_steps"],
            ["idle", "awaiting_human"],
            ["idle", "forced_human_turn"],
            ["idle", "handler_idle"],
            ["idle", "aborted"],
            ["idle", "aborted_by_user"],
            ["idle", "max_total_steps"],
            ["idle", "max_total_turns"],
            ["failed", "handler_error"],
          ]
          for (const [state, reason] of resetReasons) {
            const thread = yield* threads.createThread({ agentId: "assistant" })
            yield* startRun(thread.id, claim)
            yield* sql`UPDATE threads SET session_turns = 3 WHERE id = ${thread.id}`
            yield* settleRun(thread.id, claim, { state, reason })
            expect(yield* readSessionTurns(thread.id), `${state}/${reason} should reset session_turns`).toBe(0)
          }
          for (const [state, reason] of preserveReasons) {
            const thread = yield* threads.createThread({ agentId: "assistant" })
            yield* startRun(thread.id, claim)
            yield* sql`UPDATE threads SET session_turns = 3 WHERE id = ${thread.id}`
            yield* settleRun(thread.id, claim, { state, reason })
            expect(yield* readSessionTurns(thread.id), `${state}/${reason} should preserve session_turns`).toBe(3)
          }
          // Dead-holder recoverLost and forced recoverThread both settle execution_lost and reset session_turns.
          for (const mode of ["recoverLost", "recoverThread"] as const) {
            const thread = yield* threads.createThread({ agentId: "assistant" })
            yield* startRun(thread.id, { holder: "dead-holder", flowId: `flow-${mode}` })
            yield* sql`UPDATE threads SET session_turns = 4 WHERE id = ${thread.id}`
            if (mode === "recoverLost") yield* runs.recoverLost(thread.id)
            else yield* runs.recoverThread(thread.id, true)
            expect(yield* readSessionTurns(thread.id), `${mode} should reset session_turns`).toBe(0)
          }
        }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "rules 9, 10, 12: session_turns survives database reopen, ignores human messages, survives stop(), and resets on max_session_turns",
      () =>
        withDatabaseFile((filename) =>
          Effect.gen(function* () {
            const stopper = defineTool({
              description: "Stop the run cooperatively",
              execute: async (state: ThreadState) => {
                state.execution?.stop()
                return ok("stopped")
              },
            })
            const runCommand = <A, E>(
              provider: ScriptedProvider,
              body: Effect.Effect<
                A,
                E,
                | ThreadStore
                | RunStore
                | ThreadSupervisor
                | SqlClient
                | import("../../src/registry/Registry.ts").Registry
                | import("../../src/store/MessageStore.ts").MessageStore
              >,
            ) =>
              body.pipe(
                Effect.provide(
                  Layer.merge(
                    registryOf(project({ provider, tools: { stopper }, agent: { maxSessionTurns: 3 } })),
                    Layer.provideMerge(supervisorLayer(), storeAt(filename)),
                  ),
                ),
              )
            const threadId = yield* runCommand(
              new ScriptedProvider([{ text: "turn 1" }]),
              Effect.gen(function* () {
                const thread = yield* createThread("assistant")
                // Human-only injection at rest does not increment session_turns.
                const rest = yield* stateAtRest(thread.id)
                yield* Effect.promise(() => rest.injectMessage({ role: "user", content: "human note" }))
                expect(yield* readSessionTurns(thread.id)).toBe(0)
                const { outcome } = yield* sendMessage(thread.id, "first")
                expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response" })
                expect(yield* readSessionTurns(thread.id)).toBe(1)
                return thread.id
              }),
            )
            // Second reopened connection: cooperative stop() preserves session_turns at 1.
            yield* runCommand(
              new ScriptedProvider([{ toolCalls: [{ id: "c_s", name: "stopper", arguments: {} }] }]),
              Effect.gen(function* () {
                expect(yield* readSessionTurns(threadId)).toBe(1)
                const { outcome } = yield* sendMessage(threadId, "second")
                expect(outcome).toMatchObject({ status: "idle", reason: "aborted" })
                expect(yield* readSessionTurns(threadId)).toBe(1)
              }),
            )
            // Third reopened connection: awaiting_human (no prompt work) preserves session_turns, then turn 2 increments to 2.
            yield* runCommand(
              new ScriptedProvider([{ text: "turn 2" }]),
              Effect.gen(function* () {
                const rest = yield* stateAtRest(threadId)
                yield* Effect.promise(() => rest.queueMessage({ role: "assistant", content: "for human" }))
                yield* ThreadSupervisor.use((s) => s.settled(threadId))
                expect(yield* readSessionTurns(threadId)).toBe(1)
                const { outcome } = yield* sendMessage(threadId, "third")
                expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response" })
                expect(yield* readSessionTurns(threadId)).toBe(2)
              }),
            )
            // Fourth reopened connection: turn 3 hits maxSessionTurns and resets session_turns to 0.
            yield* runCommand(
              new ScriptedProvider([{ text: "turn 3" }]),
              Effect.gen(function* () {
                const { outcome } = yield* sendMessage(threadId, "fourth")
                expect(outcome).toMatchObject({ status: "idle", reason: "max_session_turns" })
                expect(yield* readSessionTurns(threadId)).toBe(0)
              }),
            )
          }),
        ),
    )

    it.effect("rule 9: a displaced flow cannot increment session_turns after forced recovery", () =>
      Effect.gen(function* () {
        const entered = gate()
        const leave = gate()
        const hold = defineTool({
          description: "Wait for forced recovery",
          execute: async () => {
            entered.release()
            await leave.opened
            return ok("late")
          },
        })
        const provider = new ScriptedProvider([
          { toolCalls: [{ id: "c_hold", name: "hold", arguments: {} }] },
          { text: "late reply" },
        ])
        yield* Effect.gen(function* () {
          const thread = yield* createThread("assistant")
          const runs = yield* RunStore
          const running = yield* Effect.forkChild(sendMessage(thread.id, "go"))
          yield* Effect.promise(() => entered.opened)
          yield* runs.recoverThread(thread.id, true)
          leave.release()
          yield* Fiber.join(running)
          expect(yield* readSessionTurns(thread.id)).toBe(0)
        }).pipe(
          Effect.ensuring(Effect.sync(leave.release)),
          Effect.provide(
            Layer.merge(
              registryOf(project({ provider, tools: { hold }, agent: { maxSessionTurns: 5 } })),
              Layer.provideMerge(supervisorLayer(), inMemory),
            ),
          ),
        )
      }),
    )
  })
})
