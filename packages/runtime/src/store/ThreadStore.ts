import { Context, Effect } from "effect"
import { authorize, type Database, json, nowMicros, requireThread, unyielding } from "./database.ts"
import type { NewThread } from "./model.ts"
import { KeyNotWellFormed, type WriteOrigin } from "./model.ts"
import { stored, type ThreadRow, threadColumns, toThread } from "./schema.ts"

const loneSurrogate = /[\uD800-\uDFFF]/u

// SQLite stores a key as UTF-8, which has no encoding for a lone surrogate, so two such keys would collide.
const isWellFormed = (key: string) => !loneSurrogate.test(key)

export const makeThreadStore = ({ sql, threadRows, selectRun }: Database) => {
  return {
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => unyielding(sql.withTransaction(effect)),

    createThread: Effect.fn("ThreadStore.createThread")(
      function* (thread: NewThread) {
        if (thread.parentId != null) yield* selectRun(thread.parentId)
        const row = {
          id: crypto.randomUUID(),
          agent_id: stored(thread.agentId),
          parent_id: thread.parentId ?? null,
          arguments: yield* json("the thread arguments", thread.arguments ?? {}),
          created_at: yield* nowMicros,
        }
        const inserted =
          yield* sql<ThreadRow>`INSERT INTO threads ${sql.insert(row)} RETURNING ${sql.literal(threadColumns)}`
        return toThread(yield* requireThread(row.id, inserted))
      },
      sql.withTransaction,
      unyielding,
    ),

    getThread: Effect.fn("ThreadStore.getThread")(function* (threadId: string) {
      return toThread(yield* requireThread(threadId, yield* threadRows<ThreadRow>(threadId, threadColumns)))
    }, unyielding),

    getValue: Effect.fn("ThreadStore.getValue")(function* (threadId: string, key: string) {
      if (!isWellFormed(key)) return yield* new KeyNotWellFormed({ key })
      const [row] = yield* sql<{ value: string }>`SELECT value FROM kv WHERE thread_id = ${threadId} AND key = ${key}`
      return row === undefined ? null : (JSON.parse(row.value) as unknown)
    }, unyielding),

    setValue: Effect.fn("ThreadStore.setValue")(function* (
      threadId: string,
      key: string,
      value: unknown,
      origin: WriteOrigin,
    ) {
      if (!isWellFormed(key)) return yield* new KeyNotWellFormed({ key })
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const text = value == null ? null : yield* json(`the value of key ${JSON.stringify(key)}`, value)
          const refusal = authorize(threadId, yield* selectRun(threadId), origin)
          if (refusal) return yield* refusal
          if (text === null) {
            yield* sql`DELETE FROM kv WHERE thread_id = ${threadId} AND key = ${key}`
            return
          }
          yield* sql`
              INSERT INTO kv ${sql.insert({ thread_id: threadId, key, value: text })}
              ON CONFLICT (thread_id, key) DO UPDATE SET value = excluded.value`
        }),
      )
    }, unyielding),
  }
}

export class ThreadStore extends Context.Service<ThreadStore, ReturnType<typeof makeThreadStore>>()(
  "spindle/ThreadStore",
) {}
