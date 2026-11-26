import { expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as Statement from "effect/sql/Statement"
import { processId } from "#platform"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { external } from "../../src/store/model.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { claim, inMemory, toolCalls } from "./contract-fixtures.ts"

const entry = { kind: "message", message: { role: "user", content: "go" } } as const
const flow = { kind: "flow", flowId: claim.flowId } as const
const outcome = { state: "failed", reason: "step_error" } as const
const stop = { continueIfQueued: false, closing: "closed" }

const snapshot = (id: string) =>
  SqlClient.use((sql) =>
    Effect.gen(function* () {
      return {
        thread: yield* sql`SELECT * FROM threads WHERE id = ${id}`,
        messages: yield* sql`SELECT * FROM messages WHERE thread_id = ${id} ORDER BY seq`,
        queue: yield* sql`SELECT * FROM queue WHERE thread_id = ${id} ORDER BY seq`,
      }
    }),
  )

for (const op of ["settle", "terminate", "recoverThread", "recoverLost"] as const)
  it.effect(`${op} rolls back closing results when releasing the claim fails`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const runs = yield* RunStore
      const messages = yield* MessageStore
      const { id } = yield* ThreadStore.use((s) => s.createThread({ agentId: "assistant" }))
      yield* runs.admit(id, entry, claim, external)
      yield* messages.insertMessage(
        id,
        { role: "assistant", id: "caller", created_at: 1, tool_calls: toolCalls("c") },
        flow,
      )
      const before = yield* snapshot(id)
      yield* sql`CREATE TRIGGER no_release BEFORE UPDATE OF flow_id ON threads WHEN NEW.flow_id IS NULL BEGIN SELECT RAISE(ABORT, 'release refused'); END`
      const operations = {
        settle: runs.settle(id, flow, outcome, stop),
        terminate: runs.terminate(id, external),
        recoverThread: runs.recoverThread(id, true),
        recoverLost: runs.recoverLost(id),
      }
      const operation: Effect.Effect<unknown, unknown> = operations[op]
      expect(yield* Effect.flip(operation)).toMatchObject({ _tag: "SqlError" })
      expect(yield* snapshot(id)).toEqual(before)
      yield* sql`DROP TRIGGER no_release`
      yield* operation
      expect((yield* snapshot(id)).messages).toHaveLength(2)
    }).pipe(Effect.provide(inMemory)),
  )

it.effect("admit rolls back the queue insert when claiming the thread fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const runs = yield* RunStore
    const { id } = yield* ThreadStore.use((s) => s.createThread({ agentId: "assistant" }))
    const before = yield* snapshot(id)
    yield* sql`CREATE TRIGGER no_claim BEFORE UPDATE OF flow_id ON threads WHEN NEW.flow_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'claim refused'); END`
    expect(yield* Effect.flip(runs.admit(id, entry, claim, external))).toMatchObject({ _tag: "SqlError" })
    expect(yield* snapshot(id)).toEqual(before)
  }).pipe(Effect.provide(inMemory)),
)

it.effect("refuses a handle that expires after submission and before its write commits", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadStore
    const sql = yield* SqlClient
    const { id } = yield* threads.createThread({ agentId: "assistant" })
    let expired = false
    const write = threads.setValue(id, "key", "value", {
      kind: "handle",
      flowId: null,
      terminated: null,
      expired: () => expired,
    })
    const expireInsideWrite: Statement.Transformer = (statement) =>
      Effect.gen(function* () {
        expect(Option.isSome(yield* Effect.serviceOption(sql.transactionService))).toBe(true)
        expired = true
        return statement
      })
    expect(
      yield* Effect.flip(write.pipe(Effect.provideService(Statement.CurrentTransformer, expireInsideWrite))),
    ).toMatchObject({ _tag: "HandleExpired" })
    expect(yield* threads.getValue(id, "key")).toBeNull()
  }).pipe(Effect.provide(inMemory)),
)

it.effect("only the owning flow can set aside an unreadable queue entry", () =>
  Effect.gen(function* () {
    const runs = yield* RunStore
    const sql = yield* SqlClient
    const { id } = yield* ThreadStore.use((s) => s.createThread({ agentId: "assistant" }))
    const { queued } = yield* runs.admit(id, entry, claim, external)
    yield* sql`UPDATE queue SET payload = 'unreadable' WHERE seq = ${queued.seq}`
    expect(yield* runs.nextQueued(id, { flowId: "stale" })).toBeUndefined()
    expect(yield* runs.isQueued(id, queued.seq)).toBe(true)
    expect(yield* runs.nextQueued(id, flow)).toBeUndefined()
    expect(yield* sql`SELECT disposition FROM queue WHERE seq = ${queued.seq}`).toEqual([
      { disposition: "failed_delivery" },
    ])
  }).pipe(Effect.provide(inMemory)),
)

for (const change of ["flow", "process"] as const)
  it.effect(`recoverLost rechecks the ${change} under the write lock`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      const runs = yield* RunStore
      const threads = yield* ThreadStore
      const { id } = yield* threads.createThread({ agentId: "assistant" })
      const live = crypto.randomUUID()
      yield* runs.acquireHolder({ id: live, pid: processId })
      yield* runs.admit(id, entry, claim, external)
      // Change exactly one observed fact before the locked read executes.
      const replace =
        change === "flow"
          ? sql`UPDATE threads SET flow_id = 'replacement' WHERE id = ${id}`
          : sql`UPDATE threads SET holder_id = ${live} WHERE id = ${id}`
      let sawUnlocked = false
      let changed = false
      const betweenReads: Statement.Transformer = (statement) =>
        Effect.gen(function* () {
          if (!Option.isSome(yield* Effect.serviceOption(sql.transactionService))) sawUnlocked = true
          else if (!changed) {
            expect(sawUnlocked).toBe(true)
            changed = true
            yield* Effect.orDie(replace)
          }
          return statement
        })
      const recovered = yield* runs
        .recoverLost(id)
        .pipe(Effect.provideService(Statement.CurrentTransformer, betweenReads))
      expect(changed).toBe(true)
      expect(recovered).toEqual([])
      expect((yield* threads.getThread(id)).status.state).toBe("running")
    }).pipe(Effect.provide(inMemory)),
  )
