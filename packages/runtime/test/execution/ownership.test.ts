import { expect, it } from "@effect/vitest"
import { defineTool } from "@standardagents/spec"
import { Effect, Exit, Fiber, Layer, Scope } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { gate, ok, project, using } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread } from "../../src/execution/trigger.ts"
import { external } from "../../src/store/model.ts"
import { RunStore } from "../../src/store/RunStore.ts"
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
