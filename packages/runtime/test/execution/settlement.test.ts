import { expect, it } from "@effect/vitest"
import { defineTool } from "@standardagents/spec"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { gate, ok, project } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage } from "../../src/execution/trigger.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { layer } from "../../src/store/sqlite.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { registryOf } from "../spindle-driver.ts"

it.effect("a refused idle settlement reaches the sender without a second settlement as failed", () =>
  Effect.gen(function* () {
    const thread = yield* createThread("assistant")
    const sql = yield* SqlClient
    yield* sql`CREATE TRIGGER refuse_idle BEFORE UPDATE OF run_state ON threads WHEN NEW.run_state = 'idle'
      BEGIN SELECT RAISE(ABORT, 'idle settlement refused'); END`
    const result = yield* Effect.result(sendMessage(thread.id, "go"))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SqlError" } })
    expect((yield* ThreadStore.use((s) => s.getThread(thread.id))).status.state).toBe("running")
  }).pipe(
    Effect.provide(
      Layer.merge(
        registryOf(project({ provider: new ScriptedProvider([{ text: "done" }]) })),
        Layer.provideMerge(supervisorLayer(), layer.pipe(Layer.provideMerge(SqliteLive({ filename: ":memory:" })))),
      ),
    ),
  ),
)

it.effect("refuses a stop while the aborted tool still holds the thread", () => {
  const entered = gate()
  const leave = gate()
  const tool = defineTool({
    description: "Wait for release",
    execute: async () => {
      entered.release()
      await leave.opened
      return ok("done")
    },
  })
  const registry = registryOf(
    project({
      provider: new ScriptedProvider([{ toolCalls: [{ id: "1", name: "wait", arguments: {} }] }]),
      tools: { wait: tool },
    }),
  )
  return Effect.gen(function* () {
    const { id } = yield* createThread("assistant")
    const supervisor = yield* ThreadSupervisor
    const sent = yield* Effect.forkChild(sendMessage(id, "go"))
    yield* Effect.promise(() => entered.opened)
    const settlement = yield* supervisor.abort(id)
    const stopped = yield* supervisor.stop(id)
    leave.release()
    expect(stopped).toBe(false)
    expect(settlement?.isDone()).toBe(false)
    expect((yield* Fiber.join(sent)).outcome?.reason).toBe("aborted_by_user")
  }).pipe(
    Effect.provide(
      Layer.merge(
        registry,
        Layer.provideMerge(supervisorLayer(), layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))),
      ),
    ),
  )
})

for (const mode of ["abort", "terminate"] as const)
  it.effect(`preserves the sender's outcome on ${mode} while committed metadata is pending`, () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<void>()
      const entered = gate()
      const release = gate()
      const registry = registryOf(
        project({
          provider: new ScriptedProvider([{ text: "reply" }], {
            getResponseMetadata: async () => {
              entered.release()
              await release.opened
              return {}
            },
          }),
        }),
      )
      const stores = Layer.effect(
        RunStore,
        RunStore.use((store) =>
          Effect.succeed({
            ...store,
            settle: (...args: Parameters<typeof store.settle>) =>
              store.settle(...args).pipe(Effect.tap(() => Deferred.succeed(committed, undefined))),
          }),
        ),
      ).pipe(Layer.provideMerge(layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))))
      yield* Effect.gen(function* () {
        const { id } = yield* createThread("assistant")
        const supervisor = yield* ThreadSupervisor
        const sent = yield* Effect.forkChild(sendMessage(id, "go"))
        yield* Effect.promise(() => entered.opened)
        yield* Deferred.await(committed)
        if (mode === "terminate") yield* supervisor.control(id).terminate({ kind: "external" })
        else yield* supervisor.abort(id)
        const { outcome, status } = yield* Fiber.join(sent)
        expect(status.reason).toBe("stop_on_response")
        expect(outcome).toMatchObject(
          mode === "terminate"
            ? { status: "idle", reason: "stop_on_response", trace: [], modelCalls: [] }
            : { status: "failed", reason: "execution_lost", trace: [], modelCalls: [] },
        )
      }).pipe(
        Effect.ensuring(Effect.sync(release.release)),
        Effect.provide(Layer.merge(registry, Layer.provideMerge(supervisorLayer(), stores))),
      )
    }),
  )
