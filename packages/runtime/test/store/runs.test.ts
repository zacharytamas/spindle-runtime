import { describe, expect, it } from "@effect/vitest"
import { definePrompt, defineTool, type ThreadState } from "@standardagents/spec"
import { Effect, Fiber, Layer } from "effect"
import * as Migrator from "effect/sql/Migrator"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { handlerOf, handlerProject } from "../../../conformance/src/scenarios/handlers/fixtures.ts"
import { gate, ok, project, stubTool } from "../../../conformance/src/scenarios/harness.ts"
import { dualProject } from "../../../conformance/src/scenarios/sides/fixtures.ts"
import { admitEntry, drainEntries, settleRun, startRun } from "../../scripts/store-fixtures.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage, stateAtRest } from "../../src/execution/trigger.ts"
import threadsMigration from "../../src/store/migrations/0001_threads.ts"
import revisionsMigration from "../../src/store/migrations/0002_revision.ts"
import claimsMigration from "../../src/store/migrations/0003_claims.ts"
import admissionMigration from "../../src/store/migrations/0004_message_admission.ts"
import resultPromptMigration from "../../src/store/migrations/0005_result_prompt.ts"
import waitingSendersMigration from "../../src/store/migrations/0006_waiting_senders.ts"
import sessionTurnsMigration from "../../src/store/migrations/0007_session_turns.ts"
import handlerDeliveryMigration from "../../src/store/migrations/0008_handler_delivery.ts"
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

  describe("handler delivery cursors and queued tool side (rules 12, 20, 21, 27, §3)", () => {
    const readCursors = (threadId: string) =>
      SqlClient.use((sql) =>
        Effect.map(
          sql<{ side_a_delivered_seq: number; side_b_delivered_seq: number; session_turns: number }>`
            SELECT side_a_delivered_seq, side_b_delivered_seq, session_turns FROM threads WHERE id = ${threadId}`,
          (rows) => rows[0],
        ),
      )

    const messageSeqOf = (threadId: string, id: string) =>
      SqlClient.use((sql) =>
        Effect.map(
          sql<{ seq: number }>`SELECT seq FROM messages WHERE thread_id = ${threadId} AND id = ${id}`,
          (rows) => rows[0]?.seq,
        ),
      )

    it.effect("migration 0008 initializes side_a_delivered_seq and side_b_delivered_seq to 0", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "relay" })
        expect(yield* readCursors(thread.id)).toEqual({
          side_a_delivered_seq: 0,
          side_b_delivered_seq: 0,
          session_turns: 0,
        })
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect(
      "rules 12, 20: atomic dequeue advances delivered_seq before handler.execute runs, persists across reopen, and preserves session_turns on handler_error",
      () =>
        withDatabaseFile((filename) =>
          Effect.gen(function* () {
            const observedInHandler: Array<{
              readonly msgSeq: number | undefined
              readonly cursorA: number | undefined
              readonly queueLeft: number
            }> = []
            let readInside: (messageId: string) => Promise<{
              readonly msgSeq: number | undefined
              readonly cursorA: number | undefined
              readonly queueLeft: number
            }> = () => Promise.reject(new Error("reader not initialized"))

            const cursor_handler = handlerOf(async (_state, message) => {
              observedInHandler.push(await readInside(message.id))
              if (message.content === "throws") throw new Error("handler boom")
            })
            let threadId = ""
            const setup = handlerProject({
              sideA: { handler: "cursor_handler" },
              sideB: { human: true },
              handlers: { cursor_handler },
              agent: { maxSessionTurns: 5 },
            })
            const runWith = <A, E>(
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
                  Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), storeAt(filename))),
                ),
              )

            yield* runWith(
              Effect.gen(function* () {
                const services = yield* Effect.context<SqlClient | RunStore>()
                const runService = Effect.runPromiseWith(services)
                const thread = yield* createThread("relay")
                threadId = thread.id
                readInside = (messageId) =>
                  runService(
                    Effect.gen(function* () {
                      const cursors = yield* readCursors(threadId)
                      const msgSeq = yield* messageSeqOf(threadId, messageId)
                      const queueLeft = yield* RunStore.use((r) => r.queueLength(threadId))
                      return { msgSeq, cursorA: cursors?.side_a_delivered_seq, queueLeft }
                    }),
                  )
                const first = yield* sendMessage(threadId, "ok")
                expect(first.outcome).toMatchObject({ status: "idle", reason: "handler_idle" })
                expect(yield* readCursors(threadId)).toEqual({
                  side_a_delivered_seq: observedInHandler[0]?.msgSeq,
                  side_b_delivered_seq: 0,
                  session_turns: 1,
                })
                // Cursor was already advanced and queue row removed BEFORE handler.execute ran!
                expect(observedInHandler[0]).toEqual({
                  msgSeq: expect.any(Number),
                  cursorA: observedInHandler[0]?.msgSeq,
                  queueLeft: 0,
                })
              }),
            )

            // Reopen DB: throwing handler still advances side_a_delivered_seq before throwing and preserves session_turns = 2.
            yield* runWith(
              Effect.gen(function* () {
                const services = yield* Effect.context<SqlClient | RunStore>()
                const runService = Effect.runPromiseWith(services)
                readInside = (messageId) =>
                  runService(
                    Effect.gen(function* () {
                      const cursors = yield* readCursors(threadId)
                      const msgSeq = yield* messageSeqOf(threadId, messageId)
                      const queueLeft = yield* RunStore.use((r) => r.queueLength(threadId))
                      return { msgSeq, cursorA: cursors?.side_a_delivered_seq, queueLeft }
                    }),
                  )
                const second = yield* sendMessage(threadId, "throws")
                expect(second.outcome).toMatchObject({ status: "failed", reason: "handler_error" })
                expect(observedInHandler[1]).toEqual({
                  msgSeq: expect.any(Number),
                  cursorA: observedInHandler[1]?.msgSeq,
                  queueLeft: 0,
                })
                expect(yield* readCursors(threadId)).toEqual({
                  side_a_delivered_seq: observedInHandler[1]?.msgSeq,
                  side_b_delivered_seq: 0,
                  session_turns: 2,
                })
              }),
            )
          }),
        ),
    )

    it.effect("rule 21: advances side_b_delivered_seq before each peer-produced message invocation in seq order", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          let threadId = ""
          const observed: Array<{
            readonly content: string | null
            readonly msgSeq: number | undefined
            readonly cursorB: number | undefined
          }> = []
          let readSnapshot: (
            content: string | null,
            messageId: string,
          ) => Promise<{
            readonly content: string | null
            readonly msgSeq: number | undefined
            readonly cursorB: number | undefined
          }> = () => Promise.reject(new Error("reader not initialized"))
          const peer_handler = handlerOf(async (_state, message) => {
            observed.push(await readSnapshot(message.content, message.id))
          })
          const provider = new ScriptedProvider([
            { text: "M1", toolCalls: [{ id: "c1", name: "work", arguments: {} }] },
            { text: "M2" },
          ])
          const setup = handlerProject({
            sideA: { prompt: "worker" },
            sideB: { handler: "peer_handler" },
            provider,
            prompts: [
              definePrompt({
                name: "worker",
                toolDescription: "Worker",
                model: "scripted",
                prompt: "Work.",
                tools: ["work"],
              }),
            ],
            tools: { work: stubTool("Work", "worked") },
            handlers: { peer_handler },
          })
          yield* Effect.gen(function* () {
            const services = yield* Effect.context<SqlClient>()
            const runSql = Effect.runPromiseWith(services)
            const thread = yield* createThread("relay")
            threadId = thread.id
            readSnapshot = (content, messageId) =>
              runSql(
                Effect.gen(function* () {
                  const cursors = yield* readCursors(threadId)
                  const msgSeq = yield* messageSeqOf(threadId, messageId)
                  return { content, msgSeq, cursorB: cursors?.side_b_delivered_seq }
                }),
              )
            const { outcome } = yield* sendMessage(threadId, "go")
            expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 2 })
            expect(observed).toHaveLength(2)
            expect(observed[0]?.content).toBe("M1")
            expect(observed[0]?.cursorB).toBe(observed[0]?.msgSeq)
            expect(observed[1]?.content).toBe("M2")
            expect(observed[1]?.cursorB).toBe(observed[1]?.msgSeq)
            expect((observed[1]?.msgSeq ?? 0) > (observed[0]?.msgSeq ?? 0)).toBe(true)
          }).pipe(
            Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), storeAt(filename)))),
          )
        }),
      ),
    )

    it.effect(
      "rule 27: queueTool records side: null at rest and side: currentSide during side A and side B executions",
      () =>
        Effect.gen(function* () {
          const readQueuedToolPayloads = (threadId: string) =>
            SqlClient.use((sql) =>
              Effect.map(
                sql<{
                  payload: string
                }>`SELECT payload FROM queue WHERE thread_id = ${threadId} AND kind = 'tool' ORDER BY seq`,
                (rows) => rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>),
              ),
            )
          const noop = stubTool("No-op", "ok")
          // Observe queue payloads while a handler holds the thread so entries stay in queue until inspected.
          const enteredA = gate()
          const releaseA = gate()
          let capturedSideA: ReadonlyArray<Record<string, unknown>> = []
          let capturedSideB: ReadonlyArray<Record<string, unknown>> = []
          const handler_a = handlerOf(async (state, message) => {
            if (message.content === "from-a") {
              state.queueTool("noop", { who: "a" })
              enteredA.release()
              await releaseA.opened
              await state.injectMessage({ role: "assistant", content: "hand-to-b" })
            }
          })
          const enteredB = gate()
          const releaseB = gate()
          const handler_b = handlerOf(async (state) => {
            state.queueTool("noop", { who: "b" })
            enteredB.release()
            await releaseB.opened
          })
          const setup = handlerProject({
            sideA: { handler: "handler_a" },
            sideB: { handler: "handler_b" },
            handlers: { handler_a, handler_b },
            tools: { noop },
          })
          const awaitGateOrExit = <A, E>(opened: Promise<void>, fiber: Fiber.Fiber<A, E>, label: string) =>
            Effect.raceFirst(
              Effect.promise(() => opened),
              Effect.flatMap(Fiber.await(fiber), (exit) =>
                Effect.die(
                  exit._tag === "Failure"
                    ? `execution failed before ${label}`
                    : `execution settled before ${label}: ${JSON.stringify(exit.value)}`,
                ),
              ),
            )
          yield* Effect.gen(function* () {
            const thread = yield* createThread("relay")
            const running = yield* Effect.forkChild(sendMessage(thread.id, "from-a"))
            yield* awaitGateOrExit(enteredA.opened, running, "entering handler A")
            // Also queue at rest while the thread is held so its payload stays in queue for inspection!
            const rest = yield* stateAtRest(thread.id)
            rest.queueTool("noop", { who: "rest" })
            capturedSideA = yield* readQueuedToolPayloads(thread.id)
            releaseA.release()
            yield* awaitGateOrExit(enteredB.opened, running, "entering handler B")
            capturedSideB = yield* readQueuedToolPayloads(thread.id)
            releaseB.release()
            yield* Fiber.join(running)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                releaseA.release()
                releaseB.release()
              }),
            ),
            Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory))),
          )
          expect(capturedSideA).toEqual([
            { toolName: "noop", args: { who: "a" }, side: "a" },
            { toolName: "noop", args: { who: "rest" }, side: null },
          ])
          expect(capturedSideB.at(-1)).toEqual({ toolName: "noop", args: { who: "b" }, side: "b" })

          // Verify prompt side B also records side: "b" in queue payload.
          const enteredPromptB = gate()
          const releasePromptB = gate()
          let promptBPayloads: ReadonlyArray<Record<string, unknown>> = []
          const q_from_b = defineTool({
            description: "Queue tool from prompt side B",
            execute: async (state: ThreadState) => {
              state.queueTool("noop", { who: "prompt-b" })
              enteredPromptB.release()
              await releasePromptB.opened
              return ok("queued")
            },
          })
          const dual = dualProject({
            providerA: new ScriptedProvider([{ text: "A1" }]),
            providerB: new ScriptedProvider([
              { toolCalls: [{ id: "c1", name: "q_from_b", arguments: {} }] },
              { text: "B done" },
            ]),
            tools: { q_from_b, noop },
            promptA: { tools: [] },
            promptB: { tools: ["q_from_b", "noop"] },
            agent: { maxSessionTurns: 2 },
          })
          yield* Effect.gen(function* () {
            const thread = yield* createThread("pair")
            const running = yield* Effect.forkChild(sendMessage(thread.id, "go"))
            yield* Effect.promise(() => enteredPromptB.opened)
            promptBPayloads = yield* readQueuedToolPayloads(thread.id)
            releasePromptB.release()
            yield* Fiber.join(running)
          }).pipe(
            Effect.ensuring(Effect.sync(releasePromptB.release)),
            Effect.provide(Layer.merge(registryOf(dual), Layer.provideMerge(supervisorLayer(), inMemory))),
          )
          expect(promptBPayloads).toEqual([{ toolName: "noop", args: { who: "prompt-b" }, side: "b" }])
        }),
    )

    it.effect(
      "migration 0009 preserves existing queue rows, dispositions, waiting senders, high-water sequence, index, and foreign key",
      () =>
        withDatabaseFile((filename) =>
          Effect.gen(function* () {
            const migrateToV8 = Migrator.make({})({
              loader: Migrator.fromRecord({
                "0001_threads": threadsMigration,
                "0002_revision": revisionsMigration,
                "0003_claims": claimsMigration,
                "0004_message_admission": admissionMigration,
                "0005_result_prompt": resultPromptMigration,
                "0006_waiting_senders": waitingSendersMigration,
                "0007_session_turns": sessionTurnsMigration,
                "0008_handler_delivery": handlerDeliveryMigration,
              }),
            })
            const threadId = "t-upgrade-0009"
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient
              yield* sql`PRAGMA foreign_keys = ON`
              yield* migrateToV8
              yield* sql`INSERT INTO threads (id, agent_id, arguments, created_at, run_since)
                VALUES (${threadId}, 'assistant', '{}', 1000, 1000)`
              const msg1 = JSON.stringify({ role: "user", content: "pending-msg" })
              const msg2 = JSON.stringify({ role: "user", content: "failed-msg" })
              const tool3 = JSON.stringify({ toolName: "lookup", args: { q: "x" }, side: "a" })
              const msg10 = JSON.stringify({ role: "user", content: "deleted-high" })
              yield* sql`INSERT INTO queue (seq, thread_id, kind, payload, queued_at, disposition)
                VALUES (1, ${threadId}, 'message', ${msg1}, 1001, 'pending'),
                       (2, ${threadId}, 'message', ${msg2}, 1002, 'failed_delivery'),
                       (3, ${threadId}, 'tool', ${tool3}, 1003, 'pending'),
                       (10, ${threadId}, 'message', ${msg10}, 1010, 'pending')`
              yield* sql`DELETE FROM queue WHERE seq = 10`
              yield* sql`INSERT INTO holders (id, pid) VALUES ('h-upgrade', 1234)`
              yield* sql`INSERT INTO waiting_senders (thread_id, seq, holder_id, failed)
                VALUES (${threadId}, 1, 'h-upgrade', 0), (${threadId}, 10, 'h-upgrade', 0)`
            }).pipe(Effect.provide(SqliteLive({ filename })))

            yield* Effect.gen(function* () {
              const sql = yield* SqlClient
              const rows = yield* sql<{ seq: number; kind: string; disposition: string }>`
                SELECT seq, kind, disposition FROM queue WHERE thread_id = ${threadId} ORDER BY seq`
              expect(rows).toEqual([
                { seq: 1, kind: "message", disposition: "pending" },
                { seq: 2, kind: "message", disposition: "failed_delivery" },
                { seq: 3, kind: "tool", disposition: "pending" },
              ])
              const senders = yield* sql<{ seq: number; failed: number }>`
                SELECT seq, failed FROM waiting_senders WHERE thread_id = ${threadId} ORDER BY seq`
              expect(senders).toEqual([
                { seq: 1, failed: 0 },
                { seq: 10, failed: 0 },
              ])
              const admitted = yield* admitEntry(threadId, { kind: "agent", agentName: "helper" }, claim)
              expect(admitted.queued.seq).toBeGreaterThan(10)
              const indexes = yield* sql<{ name: string }>`
                SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'queue' AND name = 'queue_by_thread'`
              expect(indexes).toHaveLength(1)
              const fkError = yield* Effect.flip(
                sql`INSERT INTO queue (thread_id, kind, payload, queued_at) VALUES ('missing-thread', 'agent', '{}', 2000)`,
              )
              expect(fkError._tag).toBe("SqlError")
            }).pipe(Effect.provide(storeAt(filename)))
          }),
        ),
    )
  })
})
