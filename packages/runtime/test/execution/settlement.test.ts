import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { project } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage } from "../../src/execution/trigger.ts"
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
