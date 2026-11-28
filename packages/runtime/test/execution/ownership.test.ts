import { describe, expect, it } from "@effect/vitest"
import { defineHook, definePrompt, defineTool, type ThreadState } from "@standardagents/spec"
import { Effect, Exit, Fiber, Latch, Layer, Scope } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { z } from "zod"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { directProject, promptAgent } from "../../../conformance/src/scenarios/direct-execution/fixtures.ts"
import { handlerOf, handlerProject } from "../../../conformance/src/scenarios/handlers/fixtures.ts"
import { attempt, gate, ok, project, stubTool, using } from "../../../conformance/src/scenarios/harness.ts"
import { dualProject } from "../../../conformance/src/scenarios/sides/fixtures.ts"
import { CLOSING } from "../../src/execution/run-status.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { notRun } from "../../src/execution/tools.ts"
import { createThread, sendMessage, stateAtRest } from "../../src/execution/trigger.ts"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { external } from "../../src/store/model.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf, spindleDriver } from "../spindle-driver.ts"
import { inMemory } from "../store/contract-fixtures.ts"

it.effect("the control poll settles a claim of its live holder with no execution behind it", () =>
  Effect.gen(function* () {
    const supervisor = yield* ThreadSupervisor
    const runs = yield* RunStore
    const { id } = yield* createThread("assistant")
    yield* runs.admit(
      id,
      { kind: "message", message: { role: "user", content: "queued" } },
      { holder: supervisor.holderId, flowId: "orphan" },
      external,
    )
    expect((yield* supervisor.status(id)).state).toBe("running")
    yield* TestClock.adjust("250 millis")
    expect(yield* supervisor.status(id)).toMatchObject({ state: "failed", reason: "execution_lost" })
    expect(yield* runs.queueLength(id)).toBe(1)
    expect(yield* runs.holderOf(id)).toBeNull()
  }).pipe(
    Effect.provide(
      Layer.merge(
        registryOf(project({ provider: new ScriptedProvider([]) })),
        Layer.provideMerge(supervisorLayer(), inMemory),
      ),
    ),
  ),
)

const holderRows = SqlClient.use((sql) =>
  Effect.map(sql<{ id: string }>`SELECT id FROM holders ORDER BY id`, (rows) => rows.map((row) => row.id)),
)

const withSupervisor = Layer.merge(
  registryOf(project({ provider: new ScriptedProvider([]) })),
  Layer.provideMerge(supervisorLayer(), inMemory),
)

// M1c-4 rule 2: a killed process that held no claim, such as an idle spindle chat, leaves a row the poll removes.
it.effect("the control poll removes the holder row of a dead process that holds no claim", () =>
  Effect.gen(function* () {
    const supervisor = yield* ThreadSupervisor
    yield* SqlClient.use((sql) => sql`INSERT INTO holders (id, pid) VALUES ('dead', 2147483647)`)
    yield* TestClock.adjust("250 millis")
    expect(yield* holderRows).toEqual([supervisor.holderId])
  }).pipe(Effect.provide(withSupervisor)),
)

// The neighbor of rule 2 that passes today: the poll never removes a row whose process probes alive.
it.effect("the control poll keeps its own holder row and the row of a live pid with no claim", () =>
  Effect.gen(function* () {
    const supervisor = yield* ThreadSupervisor
    // Process 1 belongs to the system, so a probe of it from a test gets a permission error or finds it alive.
    yield* SqlClient.use((sql) => sql`INSERT INTO holders (id, pid) VALUES ('reused', 1)`)
    yield* TestClock.adjust("250 millis")
    expect(yield* holderRows).toEqual([supervisor.holderId, "reused"].sort())
  }).pipe(Effect.provide(withSupervisor)),
)

for (const mode of ["control poll", "local replacement", "local termination", "supervisor close"] as const)
  it.effect(`releases the outstanding callback on ${mode} before it returns`, () => {
    const entered = gate()
    const leave = gate()
    const wait = defineTool({
      description: "Wait without writing to the thread",
      execute: async () => {
        entered.release()
        await leave.opened
        return ok("late")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "wait", arguments: {} }] }, { text: "next run" }])
    const registry = registryOf(project({ provider, tools: { wait } }))
    return Effect.gen(function* () {
      const scope = yield* Scope.make()
      const service = yield* Layer.buildWithScope(supervisorLayer(), scope)
      yield* Effect.gen(function* () {
        const supervisor = yield* ThreadSupervisor
        const runs = yield* RunStore
        const { id } = yield* createThread("assistant")
        const sent = yield* Effect.forkChild(supervisor.send(id, "go"))
        yield* Effect.promise(() => entered.opened)
        if (mode === "control poll" || mode === "local replacement") {
          yield* runs.recoverThread(id, true)
          if (mode === "control poll") yield* TestClock.adjust("250 millis")
          else expect((yield* supervisor.send(id, "go again")).outcome?.reason).toBe("stop_on_response")
        } else {
          const settlement = yield* supervisor.abort(id)
          yield* TestClock.adjust("1 millis")
          expect(settlement?.isDone()).toBe(false)
          if (mode === "local termination") yield* Effect.forkChild(supervisor.control(id).terminate(external))
          else yield* Effect.forkChild(Scope.close(scope, Exit.void))
        }
        yield* TestClock.adjust("1 millis")
        expect(sent.pollUnsafe(), "the sender settled while the tool was still blocked").toBeDefined()
        const delivery = yield* Fiber.join(sent)
        expect(delivery.outcome?.reason).toBe(
          mode === "supervisor close" ? "aborted_by_user" : mode === "local termination" ? "aborted" : "execution_lost",
        )
      }).pipe(
        Effect.provideContext(service),
        Effect.ensuring(Effect.sync(leave.release)),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      )
    }).pipe(Effect.provide(Layer.merge(registry, inMemory)))
  })

it("preserves the result prompt when termination closes a queued call", async () => {
  const entered = gate()
  const leave = gate()
  const wait = defineTool({
    description: "Wait for termination",
    execute: async () => {
      entered.release()
      await leave.opened
      return ok("late")
    },
  })
  await using(
    spindleDriver,
    {
      provider: new ScriptedProvider([]),
      tools: { wait },
      side: { prompt: "helper" },
      prompt: { name: "helper" },
    },
    async (session, thread) => {
      const state = await session.state(thread)
      try {
        state.queueTool("wait", {})
        await entered.opened
        await state.terminate()
        const stored = await session.messages(thread)
        expect(stored.map((message) => [message.role, message.prompt])).toEqual([
          ["assistant", null],
          ["tool", "helper"],
        ])
        expect(stored[1]?.tool_status).toBe("error")
      } finally {
        leave.release()
      }
    },
  )
})

describe("crash between turns and mid-step on side B (rules 12, §3)", () => {
  const sessionTurnsOf = (threadId: string) =>
    SqlClient.use((sql) =>
      Effect.map(
        sql<{ session_turns: number }>`SELECT session_turns FROM threads WHERE id = ${threadId}`,
        (rows) => rows[0]?.session_turns,
      ),
    )

  const awaitLatchOrExit = <A, E>(latch: Latch.Latch, fiber: Fiber.Fiber<A, E>, label: string) =>
    Effect.raceFirst(
      latch.await,
      Effect.flatMap(Fiber.await(fiber), (exit) =>
        Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.die(`execution settled before ${label}`),
      ),
    )

  it.effect(
    "rules 12, §3: dead holder recovery between side A and side B settles execution_lost with zero open calls, preserves queue, and resets session_turns",
    () =>
      Effect.gen(function* () {
        const enteredB = Latch.makeUnsafe()
        const releaseB = gate()
        const providerA = new ScriptedProvider([{ text: "A1" }])
        const providerB = new ScriptedProvider([
          async () => {
            enteredB.openUnsafe()
            await releaseB.opened
            return { text: "never stored" }
          },
        ])
        const setup = dualProject({ providerA, providerB, agent: { maxSessionTurns: 3 } })
        yield* Effect.gen(function* () {
          const { id } = yield* createThread("pair")
          const runs = yield* RunStore
          const messages = yield* MessageStore
          const sql = yield* SqlClient
          const running = yield* Effect.forkChild(sendMessage(id, "start"))
          yield* awaitLatchOrExit(enteredB, running, "entering side B")
          // Side A completed turn 1 before side B started, so session_turns is 1.
          expect(yield* sessionTurnsOf(id)).toBe(1)
          // Queue a message while held, then simulate holder death (dead pid) and recover.
          yield* runs.admit(
            id,
            { kind: "message", message: { role: "user", content: "still queued" } },
            { holder: "other", flowId: "other" },
            external,
          )
          yield* sql`INSERT INTO holders (id, pid) VALUES ('dead-between', 2147483647)`
          yield* sql`UPDATE threads SET holder_id = 'dead-between' WHERE id = ${id}`
          expect(yield* runs.recoverLost(id)).toEqual([id])
          expect(yield* sessionTurnsOf(id)).toBe(0)
          expect(yield* runs.queueLength(id)).toBe(1)
          const stored = (yield* messages.getMessages(id, { order: "asc", includeSilent: true })).messages
          expect(stored.map((m) => [m.role, m.content])).toEqual([
            ["user", "start"],
            ["assistant", "A1"],
          ])
          releaseB.release()
          yield* Fiber.join(running)
        }).pipe(
          Effect.ensuring(Effect.sync(releaseB.release)),
          Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory))),
        )
      }),
  )

  it.effect(
    "rules 12, §3: dead holder recovery mid-step on side B closes side B's open calls with CLOSING.lost and resets session_turns",
    () =>
      Effect.gen(function* () {
        const enteredOpen = Latch.makeUnsafe()
        const releaseOpen = gate()
        const tools = {
          b_done: stubTool("Done", "finished"),
          b_open: defineTool({
            description: "Hangs until dead-holder recovery",
            execute: async () => {
              enteredOpen.openUnsafe()
              await releaseOpen.opened
              return ok("late")
            },
          }),
        }
        const providerA = new ScriptedProvider([{ text: "A1" }])
        const providerB = new ScriptedProvider([
          {
            toolCalls: [
              { id: "b1", name: "b_done", arguments: {} },
              { id: "b2", name: "b_open", arguments: {} },
            ],
          },
        ])
        const setup = dualProject({
          providerA,
          providerB,
          tools,
          promptA: { tools: [] },
          promptB: { tools: ["b_done", "b_open"] },
          agent: { maxSessionTurns: 3 },
        })
        yield* Effect.gen(function* () {
          const { id } = yield* createThread("pair")
          const runs = yield* RunStore
          const messages = yield* MessageStore
          const sql = yield* SqlClient
          const running = yield* Effect.forkChild(sendMessage(id, "start"))
          yield* awaitLatchOrExit(enteredOpen, running, "entering b_open")
          expect(yield* sessionTurnsOf(id)).toBe(1)
          yield* sql`INSERT INTO holders (id, pid) VALUES ('dead-side-b', 2147483647)`
          yield* sql`UPDATE threads SET holder_id = 'dead-side-b' WHERE id = ${id}`
          expect(yield* runs.recoverLost(id)).toEqual([id])
          expect(yield* sessionTurnsOf(id)).toBe(0)
          const history = yield* messages.history(id)
          const bCaller = history.rows.find((row) => row.message.role === "user" && row.message.content === null)
          const results = history.rows.filter((row) => row.message.role === "tool")
          expect(
            results.map((r) => [
              r.message.tool_call_id,
              r.message.tool_status,
              r.message.prompt,
              r.message.content,
              r.callerSeq,
            ]),
          ).toEqual([
            ["b1", "success", "reviewer", "finished", bCaller?.seq],
            ["b2", "error", "reviewer", CLOSING.lost, bCaller?.seq],
          ])
          releaseOpen.release()
          yield* Fiber.join(running)
        }).pipe(
          Effect.ensuring(Effect.sync(releaseOpen.release)),
          Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory))),
        )
      }),
  )
})

describe("handler crash recovery and callback lifetimes (rules 12, 20, 21, §3)", () => {
  const cursorsOf = (threadId: string) =>
    SqlClient.use((sql) =>
      Effect.map(
        sql<{ side_a_delivered_seq: number; side_b_delivered_seq: number; session_turns: number }>`
          SELECT side_a_delivered_seq, side_b_delivered_seq, session_turns FROM threads WHERE id = ${threadId}`,
        (rows) => rows[0],
      ),
    )

  const awaitLatchOrExit = <A, E>(latch: Latch.Latch, fiber: Fiber.Fiber<A, E>, label: string) =>
    Effect.raceFirst(
      latch.await,
      Effect.flatMap(Fiber.await(fiber), (exit) =>
        Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.die(`execution settled before ${label}`),
      ),
    )

  it.effect(
    "rules 12, 20, §3: crash after handler dequeue and cursor advance settles execution_lost, resets session_turns, keeps pending queue, and never redelivers",
    () =>
      Effect.gen(function* () {
        const entered = Latch.makeUnsafe()
        const release = gate()
        const delivered: Array<string | null> = []
        const gated = handlerOf(async (_state, message) => {
          delivered.push(message.content)
          if (message.content === "lost-turn") {
            entered.openUnsafe()
            await release.opened
          }
        })
        const setup = handlerProject({
          sideA: { handler: "gated" },
          sideB: { human: true },
          handlers: { gated },
          agent: { maxSessionTurns: 4 },
        })
        yield* Effect.gen(function* () {
          const { id } = yield* createThread("relay")
          const runs = yield* RunStore
          const messages = yield* MessageStore
          const sql = yield* SqlClient
          // Complete turn 1 so session_turns = 1 before the crash.
          expect((yield* sendMessage(id, "turn-1")).outcome).toMatchObject({ status: "idle", reason: "handler_idle" })
          expect((yield* cursorsOf(id))?.session_turns).toBe(1)

          // Start turn 2 and crash while handler is executing after dequeue + cursor advance.
          const running = yield* Effect.forkChild(sendMessage(id, "lost-turn"))
          yield* awaitLatchOrExit(entered, running, "entering gated handler")
          // Queue a third message while held; its dequeue has not run.
          yield* runs.admit(
            id,
            { kind: "message", message: { role: "user", content: "still-queued" } },
            { holder: "other", flowId: "other" },
            external,
          )
          yield* sql`INSERT INTO holders (id, pid) VALUES ('dead-handler', 2147483647)`
          yield* sql`UPDATE threads SET holder_id = 'dead-handler' WHERE id = ${id}`
          expect(yield* runs.recoverLost(id)).toEqual([id])

          const stored = (yield* messages.getMessages(id, { order: "asc", includeSilent: true })).messages
          expect(stored.map((m) => m.content)).toEqual(["turn-1", "lost-turn"])
          expect(yield* runs.queueLength(id)).toBe(1)
          const afterCrash = yield* cursorsOf(id)
          expect(afterCrash?.session_turns).toBe(0)
          expect(afterCrash?.side_a_delivered_seq).toBeGreaterThan(0)

          release.release()
          yield* Fiber.join(running)

          // Next trigger delivers "still-queued" and "after-crash", NEVER redelivering "lost-turn".
          expect((yield* sendMessage(id, "after-crash")).outcome).toMatchObject({
            status: "idle",
            reason: "handler_idle",
          })
          expect(delivered).toEqual(["turn-1", "lost-turn", "still-queued", "after-crash"])
        }).pipe(
          Effect.ensuring(Effect.sync(release.release)),
          Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory))),
        )
      }),
  )

  it.effect(
    "rules 20, §3: crash before handler dequeue leaves the queue entry pending and delivered_seq at 0 so the next trigger delivers it once",
    () =>
      Effect.gen(function* () {
        const delivered: Array<string | null> = []
        const record = handlerOf(async (_state, message) => {
          delivered.push(message.content)
        })
        const setup = handlerProject({
          sideA: { handler: "record" },
          sideB: { human: true },
          handlers: { record },
        })
        yield* Effect.gen(function* () {
          const { id } = yield* createThread("relay")
          const runs = yield* RunStore
          const sql = yield* SqlClient
          // Simulate a process that admitted a message and claimed the thread, then died BEFORE dequeue ran.
          yield* sql`INSERT INTO holders (id, pid) VALUES ('dead-pre-dequeue', 2147483647)`
          const admitted = yield* runs.admit(
            id,
            { kind: "message", message: { role: "user", content: "pre-dequeue" } },
            { holder: "dead-pre-dequeue", flowId: "lost-before-dequeue" },
            external,
          )
          expect(admitted.claimed).toBe(true)
          expect(yield* runs.recoverLost(id)).toEqual([id])
          expect(yield* runs.queueLength(id)).toBe(1)
          expect(yield* cursorsOf(id)).toEqual({
            side_a_delivered_seq: 0,
            side_b_delivered_seq: 0,
            session_turns: 0,
          })

          // Next trigger delivers "pre-dequeue" once, then "next" once.
          expect((yield* sendMessage(id, "next")).outcome).toMatchObject({ status: "idle", reason: "handler_idle" })
          expect(delivered).toEqual(["pre-dequeue", "next"])
        }).pipe(Effect.provide(Layer.merge(registryOf(setup), Layer.provideMerge(supervisorLayer(), inMemory))))
      }),
  )

  for (const mode of ["control poll", "local replacement", "local termination", "supervisor close"] as const)
    it.effect(`§3: releases a blocked handler callback on ${mode} before it returns`, () => {
      const entered = Latch.makeUnsafe()
      const leave = gate()
      const received: Array<string | null> = []
      const wait_handler = handlerOf(async (_state, message) => {
        received.push(message.content)
        if (message.content === "go") {
          entered.openUnsafe()
          await leave.opened
        }
      })
      const setup = handlerProject({
        sideA: { handler: "wait_handler" },
        sideB: { human: true },
        handlers: { wait_handler },
      })
      const registry = registryOf(setup)
      return Effect.gen(function* () {
        const scope = yield* Scope.make()
        const service = yield* Layer.buildWithScope(supervisorLayer(), scope)
        yield* Effect.gen(function* () {
          const supervisor = yield* ThreadSupervisor
          const runs = yield* RunStore
          const { id } = yield* createThread("relay")
          const sent = yield* Effect.forkChild(supervisor.send(id, "go"))
          yield* awaitLatchOrExit(entered, sent, "entering wait_handler")
          if (mode === "control poll" || mode === "local replacement") {
            yield* runs.recoverThread(id, true)
            if (mode === "control poll") yield* TestClock.adjust("250 millis")
            else {
              expect((yield* supervisor.send(id, "go again")).outcome?.reason).toBe("handler_idle")
              expect(received).toEqual(["go", "go again"])
            }
          } else {
            const settlement = yield* supervisor.abort(id)
            yield* TestClock.adjust("1 millis")
            expect(settlement?.isDone()).toBe(false)
            if (mode === "local termination") yield* Effect.forkChild(supervisor.control(id).terminate(external))
            else yield* Effect.forkChild(Scope.close(scope, Exit.void))
          }
          yield* TestClock.adjust("1 millis")
          expect(sent.pollUnsafe(), "the sender settled while the handler was still blocked").toBeDefined()
          const delivery = yield* Fiber.join(sent)
          expect(delivery.outcome?.reason).toBe(
            mode === "supervisor close"
              ? "aborted_by_user"
              : mode === "local termination"
                ? "aborted"
                : "execution_lost",
          )
        }).pipe(
          Effect.provideContext(service),
          Effect.ensuring(Effect.sync(leave.release)),
          Effect.ensuring(Scope.close(scope, Exit.void)),
        )
      }).pipe(Effect.provide(Layer.merge(registry, inMemory)))
    })
})

describe("direct execution lifetimes, control poll, and crash recovery (rules 45, 50-53, 60)", () => {
  const awaitLatchOrExit = <A, E>(latch: Latch.Latch, fiber: Fiber.Fiber<A, E>, label: string) =>
    Effect.raceFirst(
      latch.await,
      Effect.flatMap(Fiber.await(fiber), (exit) =>
        Exit.isFailure(exit)
          ? Effect.failCause(exit.cause)
          : Effect.die(`execution settled before ${label}: ${JSON.stringify(exit.value)}`),
      ),
    )

  const delayClaimDirect = (entered: Latch.Latch, release: Latch.Latch) =>
    Layer.effect(
      RunStore,
      Effect.gen(function* () {
        const store = yield* RunStore
        const wrapped = { ...store } as Record<string, unknown>
        const original = wrapped.claimDirect
        if (typeof original === "function") {
          wrapped.claimDirect = (...args: ReadonlyArray<unknown>) =>
            Effect.tap(Reflect.apply(original, store, args) as Effect.Effect<unknown, unknown>, () =>
              Effect.andThen(entered.open, release.await),
            )
        }
        return RunStore.of(wrapped as unknown as RunStore["Service"])
      }),
    )

  it.effect(
    "rule 45: control poll running between claimDirect and minimal execution attachment leaves the reserved claim alone",
    () =>
      Effect.gen(function* () {
        const claimed = Latch.makeUnsafe()
        const releaseClaim = Latch.makeUnsafe()
        let toolRuns = 0
        const work = defineTool({
          description: "Record execution after claimDirect",
          execute: async () => {
            toolRuns += 1
            return ok("claimed-and-ran")
          },
        })
        const storeWithDelay = delayClaimDirect(claimed, releaseClaim).pipe(Layer.provideMerge(inMemory))
        yield* Effect.gen(function* () {
          const supervisor = yield* ThreadSupervisor
          const runs = yield* RunStore
          const { id } = yield* createThread("assistant")
          const rest = yield* stateAtRest(id)

          const direct = yield* Effect.forkChild(Effect.promise(() => rest.invokeTool("work", {})))
          yield* awaitLatchOrExit(claimed, direct, "claimDirect committing")

          // The thread is already running in SQLite while minimal Execution is not yet attached to live.
          expect((yield* supervisor.status(id)).state).toBe("running")
          expect(yield* runs.holderOf(id)).not.toBeNull()

          // Trigger the 250ms control poll tick during the claimDirect -> attachment window.
          yield* TestClock.adjust("250 millis")
          expect((yield* supervisor.status(id)).state).toBe("running")
          expect(yield* runs.holderOf(id)).not.toBeNull()

          yield* releaseClaim.open
          const result = yield* Fiber.join(direct)
          expect(result).toEqual({ status: "success", result: "claimed-and-ran" })
          expect(toolRuns).toBe(1)
          expect(yield* supervisor.status(id)).toMatchObject({ state: "idle", reason: "direct_tool" })
        }).pipe(
          Effect.ensuring(releaseClaim.open),
          Effect.provide(
            Layer.merge(
              registryOf(project({ provider: new ScriptedProvider([]), tools: { work } })),
              Layer.provideMerge(supervisorLayer(), storeWithDelay),
            ),
          ),
        )
      }),
  )

  it.effect(
    "rule 51: supervisor.abort during invokeTool at rest revokes handle, holds claim until callback settles, settles aborted_by_user, and resolves to CLOSING.aborted",
    () =>
      Effect.gen(function* () {
        const entered = Latch.makeUnsafe()
        const release = gate()
        let sawAbort = false
        let lateWrite = ""
        const slow = defineTool({
          description: "Hold until released after abort",
          execute: async (state: ThreadState) => {
            state.execution?.abortSignal.addEventListener("abort", () => {
              sawAbort = true
            })
            entered.openUnsafe()
            await release.opened
            lateWrite = await attempt(() => state.setValue("after-abort", "no"))
            return ok("late-return")
          },
        })
        yield* Effect.gen(function* () {
          const supervisor = yield* ThreadSupervisor
          const threads = yield* ThreadStore
          const { id } = yield* createThread("assistant")
          const rest = yield* stateAtRest(id)

          const direct = yield* Effect.forkChild(Effect.promise(() => rest.invokeTool("slow", {})))
          yield* awaitLatchOrExit(entered, direct, "entering slow at-rest tool")

          const settlement = yield* supervisor.abort(id)
          expect(settlement).toBeDefined()
          yield* TestClock.adjust("1 millis")
          // Claim is held while the tool callback is still running.
          expect(settlement?.isDone()).toBe(false)
          expect((yield* supervisor.status(id)).state).toBe("running")
          expect(direct.pollUnsafe()).toBeUndefined()

          release.release()
          const result = yield* Fiber.join(direct)
          expect(result).toEqual({ status: "error", error: CLOSING.aborted })
          expect(sawAbort).toBe(true)
          expect(lateWrite).toMatch(/^(HandleExpired|ExecutionEnded|FlowEnded)$/)
          expect(yield* supervisor.status(id)).toMatchObject({ state: "idle", reason: "aborted_by_user" })
          expect(yield* threads.getValue(id, "after-abort")).toBeNull()
        }).pipe(
          Effect.ensuring(Effect.sync(release.release)),
          Effect.provide(
            Layer.merge(
              registryOf(project({ provider: new ScriptedProvider([]), tools: { slow } })),
              Layer.provideMerge(supervisorLayer(), inMemory),
            ),
          ),
        )
      }),
  )

  it.effect(
    "rule 51: supervisor.abort before tool execute entry (during async arg validation) holds claim and resolves invokeTool to notRun",
    () =>
      Effect.gen(function* () {
        const inValidator = Latch.makeUnsafe()
        const releaseValidator = gate()
        let executed = false
        const validated = defineTool({
          description: "Slow async validator before execute",
          args: z.object({ tag: z.string() }).refine(async () => {
            inValidator.openUnsafe()
            await releaseValidator.opened
            return true
          }),
          execute: async () => {
            executed = true
            return ok("should-not-run")
          },
        })
        yield* Effect.gen(function* () {
          const supervisor = yield* ThreadSupervisor
          const { id } = yield* createThread("assistant")
          const rest = yield* stateAtRest(id)

          const direct = yield* Effect.forkChild(Effect.promise(() => rest.invokeTool("validated", { tag: "a" })))
          yield* awaitLatchOrExit(inValidator, direct, "entering async validator")

          const settlement = yield* supervisor.abort(id)
          expect(settlement).toBeDefined()
          yield* TestClock.adjust("1 millis")
          expect(settlement?.isDone()).toBe(false)

          releaseValidator.release()
          const result = yield* Fiber.join(direct)
          expect(result).toEqual(notRun)
          expect(executed).toBe(false)
          expect(yield* supervisor.status(id)).toMatchObject({ state: "idle", reason: "aborted_by_user" })
        }).pipe(
          Effect.ensuring(Effect.sync(releaseValidator.release)),
          Effect.provide(
            Layer.merge(
              registryOf(project({ provider: new ScriptedProvider([]), tools: { validated } })),
              Layer.provideMerge(supervisorLayer(), inMemory),
            ),
          ),
        )
      }),
  )

  it.effect(
    "rule 52: terminate() during invokeTool at rest displaces execution immediately, refuses writes with FlowEnded, and resolves to CLOSING.terminated",
    () =>
      Effect.gen(function* () {
        const inWriteHook = Latch.makeUnsafe()
        const releaseHook = gate()
        const releaseTool = gate()
        const doneLate = Latch.makeUnsafe()
        let submittedWriteTag = ""
        let laterWriteTag = ""
        const pauseHook = defineHook({
          hook: "before_create_message",
          id: "pause_direct_write",
          execute: async (_state, message) => {
            if (message.content === "in-flight-write") {
              inWriteHook.openUnsafe()
              await releaseHook.opened
            }
            return message
          },
        })
        const stubborn = defineTool({
          description: "Start a write, pause in hook, then attempt another write after terminate",
          execute: async (state: ThreadState) => {
            const pendingWrite = attempt(() => state.injectMessage({ role: "user", content: "in-flight-write" }))
            await releaseTool.opened
            submittedWriteTag = await pendingWrite
            laterWriteTag = await attempt(() => state.setValue("after-term", "no"))
            doneLate.openUnsafe()
            return ok("late")
          },
        })
        yield* Effect.gen(function* () {
          const supervisor = yield* ThreadSupervisor
          const messages = yield* MessageStore
          const threads = yield* ThreadStore
          const { id } = yield* createThread("assistant")
          const rest = yield* stateAtRest(id)

          const direct = yield* Effect.forkChild(Effect.promise(() => rest.invokeTool("stubborn", {})))
          yield* awaitLatchOrExit(inWriteHook, direct, "entering before_create_message inside direct tool")

          yield* supervisor.control(id).terminate(external)
          // Local execution is displaced immediately and resolves invokeTool to CLOSING.terminated without waiting on tool.
          const result = yield* Fiber.join(direct)
          expect(result).toEqual({ status: "error", error: CLOSING.terminated })
          expect(yield* supervisor.status(id)).toMatchObject({ state: "idle", reason: "aborted" })
          expect((yield* threads.getThread(id)).terminated).not.toBeNull()

          releaseHook.release()
          releaseTool.release()
          yield* doneLate.await
          expect(submittedWriteTag).toBe("FlowEnded")
          expect(laterWriteTag).toMatch(/^(FlowEnded|HandleExpired|ExecutionEnded)$/)
          expect((yield* messages.getMessages(id, { order: "asc", includeSilent: true })).messages).toEqual([])
          expect(yield* threads.getValue(id, "after-term")).toBeNull()
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              releaseHook.release()
              releaseTool.release()
            }),
          ),
          Effect.provide(
            Layer.merge(
              registryOf(
                project({
                  provider: new ScriptedProvider([]),
                  tools: { stubborn },
                  hooks: [pauseHook],
                  agent: { hooks: ["pause_direct_write"] },
                }),
              ),
              Layer.provideMerge(supervisorLayer(), inMemory),
            ),
          ),
        )
      }),
  )

  it.effect(
    "rule 53: dead holder recovery during invokeTool at rest settles execution_lost, removes dead holder, preserves writes and queue, and never replays the tool",
    () =>
      Effect.gen(function* () {
        const entered = Latch.makeUnsafe()
        const release = gate()
        let toolRuns = 0
        const gated = defineTool({
          description: "Commit a KV value then block for crash recovery",
          execute: async (state: ThreadState) => {
            toolRuns += 1
            await state.setValue("committed_before_crash", true)
            entered.openUnsafe()
            await release.opened
            return ok("late")
          },
        })
        yield* Effect.gen(function* () {
          const runs = yield* RunStore
          const threads = yield* ThreadStore
          const sql = yield* SqlClient
          const { id } = yield* createThread("assistant")
          const rest = yield* stateAtRest(id)

          const direct = yield* Effect.forkChild(Effect.promise(() => rest.invokeTool("gated", {})))
          yield* awaitLatchOrExit(entered, direct, "entering gated direct tool")

          yield* runs.admit(
            id,
            { kind: "message", message: { role: "user", content: "queued-during-direct" } },
            { holder: "other", flowId: "other" },
            external,
          )
          yield* sql`INSERT INTO holders (id, pid) VALUES ('dead-direct', 2147483647)`
          yield* sql`UPDATE threads SET holder_id = 'dead-direct' WHERE id = ${id}`

          expect(yield* runs.recoverLost(id)).toEqual([id])
          expect((yield* threads.getThread(id)).status).toMatchObject({ state: "failed", reason: "execution_lost" })
          expect(yield* holderRows).not.toContain("dead-direct")
          expect(yield* threads.getValue(id, "committed_before_crash")).toBe(true)
          expect(yield* runs.queueLength(id)).toBe(1)

          release.release()
          yield* Fiber.join(direct)

          // Next trigger delivers the queued message and NEVER replays the lost direct tool.
          expect((yield* sendMessage(id, "after-crash")).outcome).toMatchObject({
            status: "idle",
            reason: "stop_on_response",
          })
          expect(toolRuns).toBe(1)
        }).pipe(
          Effect.ensuring(Effect.sync(release.release)),
          Effect.provide(
            Layer.merge(
              registryOf(project({ provider: new ScriptedProvider([{ text: "recovered" }]), tools: { gated } })),
              Layer.provideMerge(supervisorLayer(), inMemory),
            ),
          ),
        )
      }),
  )

  it.effect(
    "rule 60: crash after runAgent consumeQueued closes open calls without replay; crash before consumeQueued leaves agent entry pending for next trigger",
    () =>
      Effect.gen(function* () {
        // Part 1: Crash AFTER consumeQueued (inside helper agent's tool call) -> CLOSING.lost, no replay of helper.
        const entered = Latch.makeUnsafe()
        const release = gate()
        let helperRuns = 0
        const primaryProvider = new ScriptedProvider([{ text: "primary-after-crash" }])
        const helperProvider = new ScriptedProvider([
          () => {
            helperRuns += 1
            return { toolCalls: [{ id: "c_helper", name: "hold_helper", arguments: {} }] }
          },
        ])
        const helper = promptAgent("helper", helperProvider, { tools: ["hold_helper"] })
        const hold_helper = defineTool({
          description: "Hold inside runAgent target",
          execute: async () => {
            entered.openUnsafe()
            await release.opened
            return ok("late")
          },
        })
        yield* Effect.gen(function* () {
          const runs = yield* RunStore
          const messages = yield* MessageStore
          const supervisor = yield* ThreadSupervisor
          const sql = yield* SqlClient
          const { id } = yield* createThread("assistant")
          const rest = yield* stateAtRest(id)

          yield* Effect.promise(() => rest.runAgent("helper"))
          const settled = yield* Effect.forkChild(supervisor.settled(id))
          yield* awaitLatchOrExit(entered, settled, "entering hold_helper inside runAgent")

          yield* sql`INSERT INTO holders (id, pid) VALUES ('dead-after-consume', 2147483647)`
          yield* sql`UPDATE threads SET holder_id = 'dead-after-consume' WHERE id = ${id}`
          expect(yield* runs.recoverLost(id)).toEqual([id])
          expect(yield* runs.queueLength(id)).toBe(0)
          const results = (yield* messages.getMessages(id, { order: "asc", includeSilent: true })).messages.filter(
            (m) => m.role === "tool",
          )
          expect(results).toEqual([
            expect.objectContaining({
              tool_call_id: "c_helper",
              tool_status: "error",
              content: CLOSING.lost,
            }),
          ])
          release.release()
          yield* Fiber.join(settled)

          // Next send runs primary ("assistant"), NEVER replaying "helper".
          expect((yield* sendMessage(id, "next")).outcome).toMatchObject({ status: "idle", reason: "stop_on_response" })
          expect(helperRuns).toBe(1)
          expect((yield* messages.getMessages(id, { order: "asc" })).messages.at(-1)?.content).toBe(
            "primary-after-crash",
          )
        }).pipe(
          Effect.ensuring(Effect.sync(release.release)),
          Effect.provide(
            Layer.merge(
              registryOf(
                directProject({
                  provider: primaryProvider,
                  tools: { hold_helper },
                  models: [helper.model],
                  prompts: [
                    definePrompt({
                      name: "assistant",
                      toolDescription: "Primary",
                      model: "scripted",
                      prompt: "Primary.",
                      tools: [],
                    }),
                    helper.prompt,
                  ],
                  agents: [helper.agent],
                }),
              ),
              Layer.provideMerge(supervisorLayer(), inMemory),
            ),
          ),
        )

        // Part 2: Crash BEFORE consumeQueued leaves kind='agent' pending so next trigger runs target agent.
        const prePrimary = new ScriptedProvider([{ text: "primary-unused" }])
        const preHelperProvider = new ScriptedProvider([{ text: "helper-ran-after-recovery" }])
        const preHelper = promptAgent("helper", preHelperProvider)
        yield* Effect.gen(function* () {
          const runs = yield* RunStore
          const messages = yield* MessageStore
          const sql = yield* SqlClient
          const { id } = yield* createThread("assistant")
          yield* sql`INSERT INTO holders (id, pid) VALUES ('dead-pre-consume', 2147483647)`
          yield* sql`INSERT INTO queue (thread_id, kind, payload, queued_at) VALUES (${id}, 'agent', ${JSON.stringify({ agentName: "helper" })}, 1)`
          yield* sql`UPDATE threads SET run_state = 'running', holder_id = 'dead-pre-consume', flow_id = 'lost-pre-agent' WHERE id = ${id}`

          expect(yield* runs.recoverLost(id)).toEqual([id])
          expect(yield* runs.queueLength(id)).toBe(1)

          // Next trigger consumes the pending agent entry and runs helper over the thread.
          expect((yield* sendMessage(id, "wake")).outcome).toMatchObject({ status: "idle", reason: "stop_on_response" })
          expect((yield* messages.getMessages(id, { order: "asc" })).messages.at(-1)).toMatchObject({
            content: "helper-ran-after-recovery",
            prompt: "helper_prompt",
          })
        }).pipe(
          Effect.provide(
            Layer.merge(
              registryOf(
                directProject({
                  provider: prePrimary,
                  models: [preHelper.model],
                  prompts: [
                    definePrompt({
                      name: "assistant",
                      toolDescription: "Primary",
                      model: "scripted",
                      prompt: "Primary.",
                      tools: [],
                    }),
                    preHelper.prompt,
                  ],
                  agents: [preHelper.agent],
                }),
              ),
              Layer.provideMerge(supervisorLayer(), inMemory),
            ),
          ),
        )
      }),
  )
})
